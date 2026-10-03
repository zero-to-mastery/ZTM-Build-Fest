//! Portable application operations shared by the native library and manual ABI.
use crate::error::KinError;
use crate::protocol::{self, DecodedRequest, PROTOCOL_V6, PROTOCOL_V7, PROTOCOL_V8};
use crate::state::{self, HouseholdState};

pub fn project(request: &DecodedRequest) -> Result<HouseholdState, KinError> {
    if request.protocol_version == PROTOCOL_V8 {
        state::rebuild_distributed_on(
            &request.events,
            request.as_of.ok_or(KinError::MalformedProtocol)?,
            request.civil_date.ok_or(KinError::MalformedProtocol)?,
        )
    } else if let Some(date) = request.civil_date {
        state::rebuild_on(
            &request.events,
            request.as_of.ok_or(KinError::MalformedProtocol)?,
            date,
        )
    } else if let Some(time) = request.as_of {
        state::rebuild_at(&request.events, time)
    } else {
        state::rebuild(&request.events)
    }
}

pub fn encode_projection(
    request: &DecodedRequest,
    household: &HouseholdState,
) -> Result<Vec<u8>, KinError> {
    if request.protocol_version >= PROTOCOL_V6 {
        let summary =
            state::summarize_validated(&request.events, request.summary_cursor, household)?;
        match request.protocol_version {
            PROTOCOL_V8 => protocol::encode_state_v8(household, &summary),
            PROTOCOL_V7 => protocol::encode_state_v7(household, &summary),
            _ => protocol::encode_state_v6(household, &summary),
        }
    } else {
        protocol::encode_state(household, request.protocol_version)
    }
}

pub fn replay(bytes: &[u8]) -> Result<Vec<u8>, KinError> {
    let request = protocol::decode_request_with_summary(bytes)?;
    encode_projection(&request, &project(&request)?)
}
