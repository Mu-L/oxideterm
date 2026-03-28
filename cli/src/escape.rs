//! SSH-style escape sequence detector.
//!
//! Detects `~.` (detach), `~?` (help), `~~` (literal tilde)
//! only when `~` appears immediately after a newline character.

/// Result of processing a byte through the escape detector.
pub enum EscapeAction {
    /// Pass this byte through to the remote.
    Forward(u8),
    /// Pass two bytes through (used when `~` + unknown char both need forwarding).
    ForwardTwo(u8, u8),
    /// Detach requested (`~.`).
    Detach,
    /// Show help (`~?`).
    ShowHelp,
    /// Nothing to forward (byte consumed by state machine).
    Consumed,
}

/// States for the escape sequence state machine.
enum State {
    /// Normal input — not after a newline.
    Normal,
    /// Just saw a newline (CR or LF).
    AfterNewline,
    /// Saw `~` after a newline — waiting for the command character.
    AfterTilde,
}

/// SSH-style escape sequence detector.
///
/// Recognizes escape sequences only when `~` follows a newline:
/// - `~.` → detach
/// - `~?` → show help
/// - `~~` → send literal `~`
pub struct EscapeDetector {
    state: State,
}

impl EscapeDetector {
    /// Create a new detector. Starts in `AfterNewline` state
    /// so that `~.` works at the very beginning of a session.
    pub fn new() -> Self {
        Self {
            state: State::AfterNewline,
        }
    }

    /// Process a single input byte. Returns the action to take.
    pub fn feed(&mut self, byte: u8) -> EscapeAction {
        match self.state {
            State::Normal => {
                if byte == b'\r' || byte == b'\n' {
                    self.state = State::AfterNewline;
                }
                EscapeAction::Forward(byte)
            }
            State::AfterNewline => {
                if byte == b'~' {
                    self.state = State::AfterTilde;
                    EscapeAction::Consumed
                } else {
                    if byte != b'\r' && byte != b'\n' {
                        self.state = State::Normal;
                    }
                    EscapeAction::Forward(byte)
                }
            }
            State::AfterTilde => {
                self.state = State::Normal;
                match byte {
                    b'.' => EscapeAction::Detach,
                    b'?' => EscapeAction::ShowHelp,
                    b'~' => EscapeAction::Forward(b'~'),
                    b'\r' | b'\n' => {
                        // ~<enter> — forward both the tilde and the newline
                        self.state = State::AfterNewline;
                        EscapeAction::ForwardTwo(b'~', byte)
                    }
                    _ => {
                        // Unknown escape — forward both `~` and this byte
                        EscapeAction::ForwardTwo(b'~', byte)
                    }
                }
            }
        }
    }

    /// Generate a help text for supported escape sequences.
    pub fn help_text() -> &'static str {
        "\r\nSupported escape sequences:\r\n\
         ~.  - detach from session\r\n\
         ~?  - this message\r\n\
         ~~  - send the escape character (~)\r\n"
    }
}
