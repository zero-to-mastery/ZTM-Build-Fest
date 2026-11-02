use openblog_core::job;

#[test]
fn the_scaffold_is_the_four_headings_as_plain_markdown() {
    let body = job::scaffold_body();
    let headings: Vec<&str> = body
        .lines()
        .filter(|line| line.starts_with("## "))
        .collect();
    assert_eq!(
        headings,
        [
            "## Problem",
            "## What we found",
            "## What we did",
            "## Result"
        ]
    );
    assert!(!body.contains('<') && !body.contains("{{"));
}

#[test]
fn a_trade_is_normalized_and_an_unknown_one_lists_bundled_and_site_options() {
    assert_eq!(job::normalize_trade(" Flooring ", &[]).unwrap(), "flooring");
    assert_eq!(
        job::normalize_trade("fencing", &["Fencing".into()]).unwrap(),
        "fencing"
    );

    let none = job::normalize_trade("welding", &[]).unwrap_err();
    assert!(none.contains("`welding` is not a known trade"), "{none}");
    assert!(
        none.contains("general-contractor") && none.contains("hvac"),
        "{none}"
    );
    assert!(none.contains("extraTrades"), "{none}");

    let site = job::normalize_trade("welding", &["fencing".into()]).unwrap_err();
    assert!(site.contains("this site's own trades: fencing"), "{site}");
}

#[test]
fn a_service_is_a_short_id() {
    assert_eq!(
        job::normalize_service("Hardwood-Install").unwrap(),
        "hardwood-install"
    );
    for bad in ["", "two words", "page", "-x"] {
        assert!(job::normalize_service(bad).is_err(), "{bad}");
    }
}
