//! Stopping a worker when orb quits: it finishes what was already sent to
//! it, refuses anything new, and the caller waits until it has stopped.

use kameo::prelude::{Actor, ActorRef};

/// Stops `actor` after the messages already in its mailbox and waits until
/// it has stopped. An actor that already stopped returns at once. Callers put
/// their own time cap around this.
pub async fn stop_gracefully<A>(actor: &ActorRef<A>)
where
    A: Actor,
{
    // An error means the actor already stopped; waiting below returns at once.
    let _ = actor.stop_gracefully().await;
    actor.wait_for_shutdown().await;
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{Receiver, channel};
    use std::time::{Duration, Instant};

    use kameo::prelude::{Actor, ActorRef, Context, Message, Spawn};

    use super::stop_gracefully;

    /// A worker whose one message blocks its thread until the test lets go.
    struct Stuck;

    impl Actor for Stuck {
        type Args = Self;
        type Error = kameo::error::Infallible;

        fn on_start(
            args: Self::Args,
            _actor_ref: ActorRef<Self>,
        ) -> impl Future<Output = Result<Self, Self::Error>> + Send {
            std::future::ready(Ok(args))
        }
    }

    /// Blocks the worker's thread until the sender is dropped.
    struct Block(Receiver<()>);

    impl Message<Block> for Stuck {
        type Reply = ();

        async fn handle(
            &mut self,
            Block(release): Block,
            _ctx: &mut Context<Self, Self::Reply>,
        ) -> Self::Reply {
            let _ = release.recv();
        }
    }

    #[rstest::rstest]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_gives_up_on_a_stuck_worker_after_its_cap() {
        // Given a worker blocked on its thread until the test lets it go.
        let actor = Stuck::spawn(Stuck);
        let (release, wait) = channel();
        let _ = actor.tell(Block(wait)).await;

        // When stopping it with a 100 ms cap.
        let started = Instant::now();
        let stopped =
            tokio::time::timeout(Duration::from_millis(100), stop_gracefully(&actor)).await;
        let took = started.elapsed();
        drop(release);

        // Then the wait gives up after about the cap.
        assert!(
            stopped.is_err() && took < Duration::from_secs(1),
            "stopping a stuck worker should give up after its cap, took {took:?}"
        );
    }
}
