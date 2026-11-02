use super::*;

const BUNDLED: &str = "---\nversion: 1\nrule: Write it the way you would say it.\n---\n\n<!-- a note -->\n\n## stories: Stories\nTell it as a story.\n\n### a-mistake: A mistake\nwords: 80-200\nTell a story\nover two lines.\n\n### a-place: A place\nwords: 60-150\nDescribe a place.\n\n## humor: Humor\n\n### a-rant: A rant\nwords: 40-100\nRant.\n";

fn site(source: &str) -> Result<Catalog, String> {
    Catalog::load(BUNDLED, Some(source))
}

#[test]
fn the_bundled_text_parses_into_packs_and_prompts() {
    let catalog = Catalog::parse_bundled(BUNDLED).unwrap();
    assert_eq!(catalog.version, 1);
    assert_eq!(catalog.rule, "Write it the way you would say it.");
    assert_eq!(catalog.packs.len(), 2);
    assert_eq!(catalog.packs[0].summary, "Tell it as a story.");
    let prompt = catalog.prompt("a-mistake").unwrap();
    assert_eq!(prompt.pack, "stories");
    assert_eq!(prompt.invitation, "Tell a story\nover two lines.");
    assert_eq!((prompt.words_min, prompt.words_max), (80, 200));
    assert!(!prompt.site);
    assert_eq!(catalog.prompts().count(), 3);
    assert!(catalog.pack("humor").is_some() && catalog.pack("nope").is_none());
}

#[test]
fn crlf_text_parses_the_same() {
    assert_eq!(
        Catalog::parse_bundled(&BUNDLED.replace('\n', "\r\n")).unwrap(),
        Catalog::parse_bundled(BUNDLED).unwrap()
    );
}

#[test]
fn bundled_errors_are_plain_sentences_with_line_numbers() {
    for (source, expected) in [
        ("---\nrule: x\n---\n## a: A\n### b: B\nwords: 1-2\nx\n", "`version`"),
        ("---\nversion: 1\n---\n## a: A\n### b: B\nwords: 1-2\nx\n", "`rule`"),
        ("---\nversion: 2\nrule: x\n---\n## a: A\n### b: B\nwords: 1-2\nx\n", "version 2"),
        ("---\nversion: 1\nrule: x\n---\n### b: B\nwords: 1-2\nx\n", "under a `## pack`"),
        ("---\nversion: 1\nrule: x\n---\n## A Pack\n", "`id: Title`"),
        ("---\nversion: 1\nrule: x\n---\n## Bad_Id: A\n", "kebab-case"),
        ("---\nversion: 1\nrule: x\n---\n## a: A\n", "has no prompts"),
        ("---\nversion: 1\nrule: x\n---\n## a: A\n### b: B\nno words\n", "`words: low-high`"),
        ("---\nversion: 1\nrule: x\n---\n## a: A\n### b: B\nwords: 9-3\nx\n", "word range"),
        ("---\nversion: 1\nrule: x\n---\n## a: A\n### b: B\nwords: 1-2\n\n", "invitation"),
        ("---\nversion: 1\nrule: x\n---\n## a: A\n### b: B\nwords: 1-2\nx\n### b: C\nwords: 1-2\ny\n", "used twice"),
        ("---\nversion: 1\nrule: x\n---\n## a: A\n### b: B\nwords: 1-2\nx\n## a: A2\n### c: C\nwords: 1-2\ny\n", "pack id `a` is used twice"),
    ] {
        let error = Catalog::parse_bundled(source).unwrap_err();
        assert!(error.contains(expected), "{error} should contain {expected}");
        assert!(error.ends_with('.'), "{error}");
    }
    let error =
        Catalog::parse_bundled("---\nversion: 1\nrule: x\n---\n## a: A\n### b: B\nwords: 1-2\n")
            .unwrap_err();
    assert!(error.starts_with("Line "), "{error}");
}

#[test]
fn site_prompts_append_and_new_packs_follow_the_bundled_ones() {
    let merged = site("## stories: Stories\n### z-late: Late\nwords: 10-20\nZ\n### a-early: Early\nwords: 10-20\nA\n\n## zebra: Zebra\n### z1: Z one\nwords: 10-20\nZ\n\n## alpha: Alpha\n### a1: A one\nwords: 10-20\nA\n").unwrap();
    let packs: Vec<&str> = merged.packs.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(packs, ["stories", "humor", "alpha", "zebra"]);
    let stories: Vec<&str> = merged.packs[0]
        .prompts
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    assert_eq!(stories, ["a-mistake", "a-place", "a-early", "z-late"]);
    assert!(merged.prompt("a-early").unwrap().site);
    assert!(!merged.prompt("a-mistake").unwrap().site);
    assert!(merged.warnings.is_empty());
}

#[test]
fn the_merge_does_not_depend_on_the_order_of_the_site_file() {
    let one = "## beta: Beta\n### b1: B\nwords: 1-2\nx\n\n## alpha: Alpha\n### a1: A\nwords: 1-2\ny\n### a0: A0\nwords: 1-2\nz\n";
    let two = "## alpha: Alpha\n### a0: A0\nwords: 1-2\nz\n### a1: A\nwords: 1-2\ny\n\n## beta: Beta\n### b1: B\nwords: 1-2\nx\n";
    assert_eq!(site(one).unwrap(), site(two).unwrap());
}

#[test]
fn a_site_prompt_with_a_bundled_id_is_refused_even_in_a_hidden_pack() {
    let error = site("## extra: Extra\n### a-rant: Mine\nwords: 1-2\nx\n").unwrap_err();
    assert!(
        error.contains("`a-rant`") && error.contains("bundled"),
        "{error}"
    );
    let error =
        site("---\ndisabled: [humor]\n---\n## extra: Extra\n### a-rant: Mine\nwords: 1-2\nx\n")
            .unwrap_err();
    assert!(error.contains("`a-rant`"), "{error}");
}

#[test]
fn disabled_packs_are_hidden_and_unknown_ones_only_warn() {
    let merged = site("---\ndisabled: [humor, nonsense, Bad Id]\n---\n").unwrap();
    assert!(merged.pack("humor").is_none());
    assert_eq!(merged.packs.len(), 1);
    assert_eq!(merged.warnings.len(), 2);
    assert!(merged.warnings.iter().any(|w| w.contains("`nonsense`")));
    assert!(merged.disabled.is_empty());
    let block = site("---\ndisabled:\n  - humor\n---\n").unwrap();
    assert!(block.pack("humor").is_none() && block.warnings.is_empty());
}

#[test]
fn a_site_pack_can_be_added_and_hidden_in_one_file() {
    let merged =
        site("---\ndisabled: [extra]\n---\n## extra: Extra\n### e1: E\nwords: 1-2\nx\n").unwrap();
    assert!(merged.pack("extra").is_none());
}

#[test]
fn a_site_file_with_nothing_in_it_changes_nothing() {
    let bundled = Catalog::parse_bundled(BUNDLED).unwrap();
    assert_eq!(site("").unwrap(), bundled);
    assert_eq!(site("---\n---\n").unwrap(), bundled);
}

#[test]
fn site_errors_say_the_site_catalog_cannot_be_used() {
    let error = site("## extra: Extra\n### Bad Id: X\n").unwrap_err();
    assert!(
        error.starts_with("The site catalog cannot be used. Line "),
        "{error}"
    );
}

#[test]
fn the_catalog_version_is_the_bundled_one_for_stamping() {
    assert_eq!(site("").unwrap().version, 1);
    assert_eq!(site("---\nversion: 99\n---\n").unwrap().version, 1);
}

#[test]
fn subcommand_names_are_reserved_prompt_ids_for_site_catalogs() {
    for id in RESERVED_PROMPT_IDS {
        let source = format!(
            "---\nversion: 1\nrule: x\n---\n## mine: Mine\n### {id}: Reserved\nwords: 1-2\nx\n"
        );
        let error = site(&source).unwrap_err();
        assert!(error.contains("reserved") && error.contains(id), "{error}");
    }
    // A longer id that merely starts with a subcommand name is fine.
    let ok = "---\nversion: 1\nrule: x\n---\n## mine: Mine\n### polish-it: Fine\nwords: 1-2\nx\n";
    assert!(site(ok).is_ok());
}
