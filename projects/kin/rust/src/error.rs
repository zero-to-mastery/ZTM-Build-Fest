use core::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum KinError {
    InvalidAbi = 1,
    MalformedProtocol = 2,
    UnsupportedVersion = 3,
    InvalidEvent = 4,
    SizeLimit = 5,
    Internal = 6,
}

impl KinError {
    pub const fn code(self) -> i32 {
        self as i32
    }

    pub const fn message(self) -> &'static str {
        match self {
            Self::InvalidAbi => "Invalid WebAssembly memory range",
            Self::MalformedProtocol => "Malformed event protocol data",
            Self::UnsupportedVersion => "Unsupported protocol or event version",
            Self::InvalidEvent => "Invalid household event stream",
            Self::SizeLimit => "Event request or result exceeds a supported limit",
            Self::Internal => "Household engine could not complete the operation",
        }
    }
}

impl fmt::Display for KinError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for KinError {}
