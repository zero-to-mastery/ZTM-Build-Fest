//! Optional social publishing, identity boundary (ADR 0293): the site scope and Admin actor rules
//! are held to `tests/fixtures/social-scope.json`, which the hosted function's tests read too.

use openblog_core::social_publishing::{ScopeError, SiteScope, SocialActor, WORKER_ACTOR};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/social-scope.json")).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn site_scopes_match_the_shared_fixture() {
    let fixture = fixture();
    for site in strings(&fixture["sites"]["accepted"]) {
        assert_eq!(SiteScope::parse(&site).unwrap().as_str(), site);
    }
    for site in strings(&fixture["sites"]["refused"]) {
        assert_eq!(
            SiteScope::parse(&site),
            Err(ScopeError::InvalidSite),
            "{site:?}"
        );
    }
}

#[test]
fn admin_actors_match_the_shared_fixture() {
    let fixture = fixture();
    for actor in strings(&fixture["actors"]["accepted"]) {
        assert_eq!(SocialActor::admin(&actor).unwrap().audit_name(), actor);
    }
    for actor in strings(&fixture["actors"]["refused"]) {
        assert_eq!(
            SocialActor::admin(&actor),
            Err(ScopeError::InvalidActor),
            "{actor:?}"
        );
    }
}

#[test]
fn the_worker_cannot_be_mistaken_for_an_admin() {
    assert_eq!(SocialActor::Worker.audit_name(), WORKER_ACTOR);
    assert!(!SocialActor::Worker.is_admin());
    assert_eq!(
        SocialActor::admin(WORKER_ACTOR),
        Err(ScopeError::InvalidActor)
    );
}

#[test]
fn a_request_never_chooses_its_site() {
    let scope = SiteScope::parse("lantern-studios").unwrap();
    assert_eq!(SiteScope::refuse_requested(None), Ok(()));
    // Naming another site, or even this one, is refused: the server decides.
    assert_eq!(
        SiteScope::refuse_requested(Some("other-site")),
        Err(ScopeError::SiteNotAccepted)
    );
    assert_eq!(
        SiteScope::refuse_requested(Some(scope.as_str())),
        Err(ScopeError::SiteNotAccepted)
    );
}

#[test]
fn a_row_from_another_site_is_an_error() {
    let scope = SiteScope::parse("lantern-studios").unwrap();
    assert_eq!(scope.ensure_owned("lantern-studios"), Ok(()));
    for other in ["other-site", "Lantern-Studios", "lantern-studios ", ""] {
        assert_eq!(
            scope.ensure_owned(other),
            Err(ScopeError::OtherSite),
            "{other:?}"
        );
    }
}
