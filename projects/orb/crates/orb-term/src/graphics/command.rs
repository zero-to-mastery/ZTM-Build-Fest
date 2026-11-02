//! One kitty graphics command, read from the bytes between `ESC _ G` and
//! `ESC \` and written back with only its control keys changed. The payload
//! is never decoded.

use std::io::Write;

/// One control value: an integer or a single character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Value {
    Int(i64),
    Char(u8),
}

/// One kitty graphics command: its control keys in the order the child sent
/// them, and its payload untouched.
#[derive(Debug)]
pub(super) struct KittyCommand<'a> {
    keys: Vec<(u8, Value)>,
    payload: Option<&'a [u8]>,
}

impl<'a> KittyCommand<'a> {
    /// Reads `<control>[;<payload>]`, where the control is `k=v` pairs split
    /// by `,`. `None` when a key isn't one ASCII letter or a value is neither
    /// an integer nor one character.
    pub(super) fn parse(body: &'a [u8]) -> Option<Self> {
        let mut parts = body.splitn(2, |&byte| byte == b';');
        let control = parts.next()?;
        let keys = control
            .split(|&byte| byte == b',')
            .filter(|pair| !pair.is_empty())
            .map(|pair| match pair {
                [key, b'=', value @ ..] if key.is_ascii_alphabetic() => {
                    Some((*key, parse_value(value)?))
                }
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            keys,
            payload: parts.next(),
        })
    }

    /// The integer `key` holds, if it holds one.
    pub(super) fn int(&self, key: u8) -> Option<i64> {
        match self.value(key)? {
            Value::Int(value) => Some(value),
            Value::Char(_) => None,
        }
    }

    /// The character `key` holds, if it holds one.
    pub(super) fn char(&self, key: u8) -> Option<u8> {
        match self.value(key)? {
            Value::Char(value) => Some(value),
            Value::Int(_) => None,
        }
    }

    fn value(&self, key: u8) -> Option<Value> {
        self.keys
            .iter()
            .find(|(name, _)| *name == key)
            .map(|&(_, value)| value)
    }

    /// Gives `key` the value `value`, in its place when it is there, else at
    /// the end.
    pub(super) fn set(&mut self, key: u8, value: Value) {
        match self.keys.iter_mut().find(|(name, _)| *name == key) {
            Some((_, old)) => *old = value,
            None => self.keys.push((key, value)),
        }
    }

    /// Drops every one of `keys`.
    pub(super) fn remove(&mut self, keys: &[u8]) {
        self.keys.retain(|(name, _)| !keys.contains(name));
    }

    /// Whether every key the command has is one of `keys`.
    pub(super) fn only(&self, keys: &[u8]) -> bool {
        self.keys.iter().all(|(name, _)| keys.contains(name))
    }

    /// Writes the whole command, `ESC _ G <keys> [; payload] ESC \`, to
    /// `out`; there is no `;` when there is no payload.
    pub(super) fn write_to(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(b"\x1b_G");
        for (n, (key, value)) in self.keys.iter().enumerate() {
            if n > 0 {
                out.push(b',');
            }
            out.extend_from_slice(&[*key, b'=']);
            match value {
                Value::Int(value) => {
                    let _ = write!(out, "{value}");
                }
                Value::Char(value) => out.push(*value),
            }
        }
        if let Some(payload) = self.payload {
            out.push(b';');
            out.extend_from_slice(payload);
        }
        out.extend_from_slice(b"\x1b\\");
    }
}

/// A control value: one non-digit character, else an integer.
fn parse_value(bytes: &[u8]) -> Option<Value> {
    match bytes {
        [byte] if !byte.is_ascii_digit() => Some(Value::Char(*byte)),
        _ => std::str::from_utf8(bytes)
            .ok()?
            .parse()
            .ok()
            .map(Value::Int),
    }
}

#[cfg(test)]
mod tests {
    use super::{KittyCommand, Value};

    /// The bytes `command` writes.
    fn written(command: &KittyCommand<'_>) -> Vec<u8> {
        let mut out = Vec::new();
        command.write_to(&mut out);
        out
    }

    #[rstest::rstest]
    fn untouched_command_serializes_to_its_own_bytes() {
        // Given a patch command as terminal-browser sends it.
        let body =
            b"a=T,f=32,s=154,v=110,t=s,i=41,p=1,C=1,z=532,X=3,Y=21,N=1,q=2;L3B4LTY1NzcwLTAtNjEy";
        let command = KittyCommand::parse(body);

        // When writing it back unchanged.
        let out = command.as_ref().map(written);

        // Then the bytes are the command's own, framed.
        let expected = [&b"\x1b_G"[..], body, b"\x1b\\"].concat();
        assert_eq!(out, Some(expected), "unchanged command bytes");
    }

    #[rstest::rstest]
    fn edited_keys_keep_their_order_and_the_payload() {
        // Given a transmit-and-place command.
        let body = b"a=T,i=1,p=1,f=32;AAAA";
        let mut command = KittyCommand::parse(body);

        // When changing its id, dropping its placement id and adding `q=2`.
        let out = command.as_mut().map(|command| {
            command.set(b'i', Value::Int(9));
            command.remove(b"p");
            command.set(b'q', Value::Int(2));
            written(command)
        });

        // Then the other keys stay where they were and the payload is kept.
        assert_eq!(
            out.as_deref(),
            Some(&b"\x1b_Ga=T,i=9,f=32,q=2;AAAA\x1b\\"[..]),
            "edited command bytes"
        );
    }

    #[rstest::rstest]
    fn command_without_payload_has_no_separator() {
        // Given a delete command, which carries no payload.
        let command = KittyCommand::parse(b"a=d,d=A,q=2");

        // When writing it back.
        let out = command.as_ref().map(written);

        // Then no `;` comes before its end.
        assert_eq!(
            out.as_deref(),
            Some(&b"\x1b_Ga=d,d=A,q=2\x1b\\"[..]),
            "payload-free command bytes"
        );
    }

    #[rstest::rstest]
    #[case::long_key(&b"ab=1;AAAA"[..])]
    #[case::digit_key(&b"1=2"[..])]
    #[case::no_value(&b"a"[..])]
    #[case::long_word(&b"a=Tx"[..])]
    fn malformed_control_is_rejected(#[case] body: &[u8]) {
        // Given a command whose control keys aren't kitty's form.

        // When reading it.
        let command = KittyCommand::parse(body);

        // Then nothing is read.
        assert!(
            command.is_none(),
            "{} should be rejected",
            String::from_utf8_lossy(body)
        );
    }
}
