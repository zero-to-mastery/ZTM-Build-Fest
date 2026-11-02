// src/app.rs

use crate::AppState;
use crate::middleware::basic_auth;
use crate::routes::{get_index_page, get_rotation_entry, health_check, post_rotation_entry_ds};
use crate::shutdown_signal;
use crate::telemetry::{MakeRequestUuid, request_span};
use axum::{
    Router,
    http::{
        HeaderName, Method,
        header::{ACCEPT, CONTENT_TYPE},
    },
    middleware,
    routing::{get, post},
};
use tokio::net::TcpListener;
use tower::ServiceBuilder;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    request_id::{PropagateRequestIdLayer, SetRequestIdLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing::info;

const X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// Datastar marks its own requests with this header so a handler can tell them
/// apart from an ordinary fetch. Without it in `allow_headers` the browser's preflight
/// fails and the island never reaches the API.
const DATASTAR_REQUEST: HeaderName = HeaderName::from_static("datastar-request");

pub struct Application {
    listener: TcpListener,
    router: Router,
}

impl Application {
    pub async fn build(addr: &str, app_state: AppState) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        info!(address = %listener.local_addr()?, "listening");
        let router = build_router(app_state);

        Ok(Self { listener, router })
    }

    pub fn port(&self) -> std::io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    pub async fn run_until_stopped(self) -> std::io::Result<()> {
        axum::serve(self.listener, self.router)
            .with_graceful_shutdown(shutdown_signal())
            .await?;

        tracing::info!("shutdown complete");

        Ok(())
    }
}

pub fn build_router(state: AppState) -> Router {
    let trace_layer = TraceLayer::new_for_http().make_span_with(request_span);

    // CORS has to sit on the whole router, not on the GET route. A browser's
    // preflight is an `OPTIONS /rotation`, which matches no registered method, so a
    // route-scoped layer never runs: axum answers 405 before CORS can add headers, and
    // the browser blocks the request with "Access-Control-Allow-Origin missing".
    //
    // Restricting `allow_methods` to GET and HEAD is therefore what actually keeps the
    // write endpoint out of reach cross-origin — a browser may not issue the POST. That
    // is a convenience, NOT authentication: `curl -X POST` bypasses CORS entirely,
    // which is why `POST /rotation` sits behind `basic_auth`.
    //
    // Origins come from `[cors] allowed_origins`. Only those browsers get an
    // `Access-Control-Allow-Origin` back; any other site's script is refused the
    // response. Non-browser clients can still read the (public) rotation.
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::HEAD])
        .allow_origin(AllowOrigin::list(state.cors_origins.clone()))
        .allow_headers([CONTENT_TYPE, ACCEPT, DATASTAR_REQUEST]);

    Router::new()
        .route("/", get(get_index_page))
        .route("/health_check", get(health_check))
        .route("/rotation", get(get_rotation_entry))
        .route(
            "/rotation",
            post(post_rotation_entry_ds)
                .layer(middleware::from_fn_with_state(state.clone(), basic_auth)),
        )
        .layer(
            ServiceBuilder::new()
                .layer(SetRequestIdLayer::new(
                    X_REQUEST_ID.clone(),
                    MakeRequestUuid,
                ))
                .layer(trace_layer)
                .layer(PropagateRequestIdLayer::new(X_REQUEST_ID))
                // Outermost, so preflight requests are answered with CORS headers
                // before anything else can reject them.
                .layer(cors),
        )
        .nest_service("/static", ServeDir::new("static"))
        .with_state(state)
}
