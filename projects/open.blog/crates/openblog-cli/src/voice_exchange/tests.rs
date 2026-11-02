use std::collections::BTreeMap;

use openblog_core::voice::VoiceMeta;

use super::*;

const ROUGH: &str = "2026-10-28-a-mistake-i-made-rough.md";
const PORTABLE_GUIDE: &str = "assistant/context/voice.md";
const POLISHED: &str = "2026-10-28-a-mistake-i-made-polished.md";

fn sample(stage: VoiceStage, body: &str) -> String {
    VoiceSample {
        title: "A mistake I made".into(),
        subtitle: None,
        slug: "a-mistake-i-made".into(),
        date: "2026-10-28T09:30:00Z".into(),
        description: None,
        tags: Vec::new(),
        voice: VoiceMeta {
            catalog: 1,
            pack: "stories".into(),
            prompt: "a-mistake-i-made".into(),
            stage,
            time_limit_seconds: if stage == VoiceStage::Rough { 180 } else { 0 },
            words: 3,
            rough_of: (stage == VoiceStage::Polished).then(|| ROUGH.to_string()),
        },
        body: body.into(),
        extra: BTreeMap::new(),
    }
    .serialize()
    .unwrap()
}

fn project(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "openblog-voice-exchange-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("openblog.json"), "{}").unwrap();
    root
}

fn put(root: &Path, visibility: Visibility, file: &str, text: &str) {
    let path = root.join(visibility.directory()).join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn put_guide(root: &Path, visibility: Visibility, text: &str) {
    let path = root.join(guide_relative(root, visibility));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn options(file: &str, write: bool) -> Options<'_> {
    Options {
        file: Some(file),
        write,
        include_private: false,
        overwrite: false,
        as_private: false,
    }
}

/// An export file made from `source`, written next to the project's files.
fn exported(source: &Path, include_private: bool) -> String {
    let (text, _, _) = gather(source, include_private).unwrap();
    let file = source.join("library.json");
    fs::write(&file, &text).unwrap();
    file.to_string_lossy().into_owned()
}

fn tree(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files: Vec<_> = fsutil::walk(root)
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    files.sort();
    files
}

#[test]
fn a_round_trip_is_byte_identical_and_a_second_import_changes_nothing() {
    let a = project("a");
    let b = project("b");
    let rough = sample(VoiceStage::Rough, "so i delted the foldr\n\nand  panicked");
    let polished = sample(VoiceStage::Polished, "I deleted the folder.");
    put(&a, Visibility::Portable, ROUGH, &rough);
    put(&a, Visibility::Portable, POLISHED, &polished);
    put_guide(&a, Visibility::Portable, "# Voice guide\n\nShort lines.\n");
    let file = exported(&a, false);
    import(&b, &options(&file, true)).unwrap();
    let read = |name: &str| fs::read(b.join("assistant/context/voice").join(name)).unwrap();
    assert_eq!(read(ROUGH), rough.as_bytes());
    assert_eq!(read(POLISHED), polished.as_bytes());
    assert_eq!(
        fs::read(b.join(PORTABLE_GUIDE)).unwrap(),
        b"# Voice guide\n\nShort lines.\n"
    );
    // The same files give the same export bytes.
    assert_eq!(gather(&a, false).unwrap().0, gather(&b, false).unwrap().0);
    let before = tree(&b);
    import(&b, &options(&file, true)).unwrap();
    assert_eq!(tree(&b), before);
}

#[test]
fn an_export_leaves_private_material_out_unless_asked_and_keeps_it_out_of_the_project() {
    let a = project("private");
    put(
        &a,
        Visibility::Private,
        ROUGH,
        &sample(VoiceStage::Rough, "secret words"),
    );
    put_guide(&a, Visibility::Private, "# Guide\nprivate guide\n");
    let (text, samples, guide) = gather(&a, false).unwrap();
    assert!(!text.contains("secret words") && !text.contains("private guide"));
    assert_eq!((samples, guide), (0, false));
    let (text, samples, guide) = gather(&a, true).unwrap();
    assert!(text.contains("secret words") && text.contains("\"private\""));
    assert_eq!((samples, guide), (1, true));
    // Inside the project but outside .openblog/private/ is refused; nothing is written.
    let mut opts = options("library.json", true);
    opts.include_private = true;
    let error = export(&a, &opts).unwrap_err();
    assert!(error.contains("private"), "{error}");
    assert!(!a.join("library.json").exists());
    opts.file = Some(".openblog/private/library.json");
    export(&a, &opts).unwrap();
    assert!(a.join(".openblog/private/library.json").is_file());
    // A portable-only export may be written anywhere.
    export(&a, &options("portable.json", true)).unwrap();
    assert!(a.join("portable.json").is_file());
}

#[test]
fn an_import_keeps_each_items_folder_and_as_private_only_ever_tightens() {
    let a = project("folders");
    let b = project("folders-b");
    put(
        &a,
        Visibility::Portable,
        ROUGH,
        &sample(VoiceStage::Rough, "shared words"),
    );
    let file = exported(&a, false);
    let mut opts = options(&file, true);
    opts.as_private = true;
    import(&b, &opts).unwrap();
    assert!(!b.join("assistant").exists());
    assert!(b
        .join(".openblog/private/context/voice")
        .join(ROUGH)
        .is_file());
    // Private text in an export lands private; it is never made portable.
    let c = project("folders-c");
    put(
        &c,
        Visibility::Private,
        ROUGH,
        &sample(VoiceStage::Rough, "secret"),
    );
    let file = exported(&c, true);
    let d = project("folders-d");
    import(&d, &options(&file, true)).unwrap();
    assert!(!d.join("assistant").exists());
    assert!(d
        .join(".openblog/private/context/voice")
        .join(ROUGH)
        .is_file());
}

#[test]
fn a_dry_run_and_an_invalid_import_write_nothing() {
    let a = project("dry");
    let b = project("dry-b");
    put(
        &a,
        Visibility::Portable,
        ROUGH,
        &sample(VoiceStage::Rough, "words"),
    );
    put(
        &a,
        Visibility::Portable,
        POLISHED,
        &sample(VoiceStage::Polished, "Words."),
    );
    let file = exported(&a, false);
    let before = tree(&b);
    import(&b, &options(&file, false)).unwrap();
    assert_eq!(tree(&b), before);
    // One bad item stops the whole import.
    let text = fs::read_to_string(&file).unwrap();
    let broken = text.replacen("voice.stage: polished", "voice.stage: sideways", 1);
    assert_ne!(text, broken);
    fs::write(&file, broken).unwrap();
    let error = import(&b, &options(&file, true)).unwrap_err();
    assert!(error.contains("nothing was written"), "{error}");
    assert_eq!(tree(&b), before);
}

#[test]
fn a_newer_export_or_sample_format_and_foreign_files_are_refused() {
    let b = project("newer");
    let write = |text: &str| {
        let file = b.join("in.json");
        fs::write(&file, text).unwrap();
        file.to_string_lossy().into_owned()
    };
    let newer_export = r#"{"format":"openblog-voice-export","version":2,"samples":[]}"#;
    let file = write(newer_export);
    let error = import(&b, &options(&file, true)).unwrap_err();
    assert!(error.contains("nothing was written"), "{error}");
    let (_, problems) = plan(&b, newer_export, false, false).unwrap();
    assert!(problems[0].contains("newer release"), "{problems:?}");
    let file = write(r#"{"format":"something-else","version":1}"#);
    assert!(import(&b, &options(&file, true)).is_err());
    // A sample written in a newer sample format.
    let newer = sample(VoiceStage::Rough, "words").replace("voice.format: 1", "voice.format: 2");
    let bundle = exchange::export(
        &[Item {
            visibility: "portable".into(),
            file: ROUGH.into(),
            content: newer,
        }],
        None,
    );
    let (_, problems) = plan(&b, &bundle, false, false).unwrap();
    assert!(problems[0].contains("newer"), "{problems:?}");
    assert!(!b.join("assistant").exists());
}

#[test]
fn a_rough_draft_is_never_replaced_and_a_polished_one_only_with_overwrite() {
    let b = project("conflict");
    put(
        &b,
        Visibility::Portable,
        ROUGH,
        &sample(VoiceStage::Rough, "my words"),
    );
    put(
        &b,
        Visibility::Portable,
        POLISHED,
        &sample(VoiceStage::Polished, "My words."),
    );
    let a = project("conflict-a");
    put(
        &a,
        Visibility::Portable,
        ROUGH,
        &sample(VoiceStage::Rough, "other words"),
    );
    put(
        &a,
        Visibility::Portable,
        POLISHED,
        &sample(VoiceStage::Polished, "Other words."),
    );
    let file = exported(&a, false);
    let before = tree(&b);
    let mut opts = options(&file, true);
    assert!(import(&b, &opts).is_err());
    opts.overwrite = true;
    let error = import(&b, &opts).unwrap_err();
    assert!(error.contains("nothing was written"), "{error}");
    assert_eq!(tree(&b), before);
    // With the same rough draft, a differing polished draft is replaced on request only.
    let c = project("conflict-c");
    put(
        &c,
        Visibility::Portable,
        ROUGH,
        &sample(VoiceStage::Rough, "other words"),
    );
    put(
        &c,
        Visibility::Portable,
        POLISHED,
        &sample(VoiceStage::Polished, "Mine."),
    );
    let mut opts = options(&file, true);
    assert!(import(&c, &opts).is_err());
    opts.overwrite = true;
    import(&c, &opts).unwrap();
    assert_eq!(
        fs::read_to_string(c.join("assistant/context/voice").join(POLISHED)).unwrap(),
        sample(VoiceStage::Polished, "Other words.")
    );
}

#[test]
fn a_guide_that_quotes_private_samples_never_lands_in_the_portable_folder() {
    let b = project("provenance");
    let guide = "# Guide\n<!-- openblog:voice-provenance sources=portable,private -->\nquote\n";
    let bundle = exchange::export(
        &[],
        Some(&Item {
            visibility: "portable".into(),
            file: String::new(),
            content: guide.into(),
        }),
    );
    let (_, problems) = plan(&b, &bundle, false, false).unwrap();
    assert!(problems[0].contains("private"), "{problems:?}");
    // The same guide is fine private.
    let private = bundle.replace("\"portable\"", "\"private\"");
    assert!(plan(&b, &private, false, false).unwrap().1.is_empty());
    // Export never lets such a guide out of the portable folder either.
    put_guide(&b, Visibility::Portable, guide);
    let (text, _, has_guide) = gather(&b, false).unwrap();
    assert!(!has_guide && !text.contains("provenance"));
}

#[test]
fn a_polished_draft_needs_its_rough_draft_and_a_name_in_both_folders_is_refused() {
    let b = project("pairs");
    let polished = Item {
        visibility: "portable".into(),
        file: POLISHED.into(),
        content: sample(VoiceStage::Polished, "Words."),
    };
    let bundle = exchange::export(std::slice::from_ref(&polished), None);
    let (_, problems) = plan(&b, &bundle, false, false).unwrap();
    assert!(problems[0].contains("rough draft"), "{problems:?}");
    // The rough draft already sits in the other folder.
    put(
        &b,
        Visibility::Private,
        ROUGH,
        &sample(VoiceStage::Rough, "words"),
    );
    let rough = Item {
        visibility: "portable".into(),
        file: ROUGH.into(),
        content: sample(VoiceStage::Rough, "words"),
    };
    let bundle = exchange::export(&[rough, polished], None);
    let (_, problems) = plan(&b, &bundle, false, false).unwrap();
    assert!(
        problems.iter().any(|p| p.contains("never moves")),
        "{problems:?}"
    );
}

#[test]
fn oversized_and_malformed_imports_are_refused_without_echoing_text() {
    let b = project("limits");
    let (_, problems) = plan(&b, "{ secret words", false, false).unwrap();
    assert!(!problems[0].contains("secret"), "{problems:?}");
    let huge = " ".repeat(MAX_EXPORT_BYTES + 1);
    let (_, problems) = plan(&b, &huge, false, false).unwrap();
    assert!(problems[0].contains("over"), "{problems:?}");
}

fn both_steps() -> Vec<Step> {
    // Deliberately polished first: apply must undo whatever order it is given.
    vec![
        Step {
            visibility: Visibility::Portable,
            file: Some(POLISHED.into()),
            content: sample(VoiceStage::Polished, "Words."),
            action: Action::Create,
        },
        Step {
            visibility: Visibility::Portable,
            file: Some(ROUGH.into()),
            content: sample(VoiceStage::Rough, "words"),
            action: Action::Create,
        },
    ]
}

#[test]
fn a_create_that_publishes_then_errors_is_still_rolled_back() {
    let b = project("apply-late-error");
    let steps = both_steps();
    let hooks = Hooks {
        after_write: |path| {
            if path.ends_with(ROUGH) {
                Err("injected failure after the write".into())
            } else {
                Ok(())
            }
        },
        restore: restore_file,
    };
    let error = apply_with(&b, &steps, &hooks).unwrap_err();
    assert!(
        error.ends_with("everything written was put back"),
        "{error}"
    );
    assert!(tree(&b)
        .iter()
        .all(|(path, _)| !path.ends_with(ROUGH) && !path.ends_with(POLISHED)));
}

#[test]
fn a_rollback_that_fails_names_the_files_it_could_not_restore() {
    let b = project("apply-stuck");
    let steps = both_steps();
    let hooks = Hooks {
        after_write: |path| {
            if path.ends_with(ROUGH) {
                Err("injected failure".into())
            } else {
                Ok(())
            }
        },
        restore: |undo| {
            if undo.path.ends_with(POLISHED) {
                Err("injected".into())
            } else {
                restore_file(undo)
            }
        },
    };
    let error = apply_with(&b, &steps, &hooks).unwrap_err();
    assert!(error.contains("could not restore:"), "{error}");
    assert!(
        error.contains(&format!("assistant/context/voice/{POLISHED}")),
        "{error}"
    );
    assert!(
        !error.contains("everything written was put back"),
        "{error}"
    );
    assert!(!error.contains(ROUGH), "{error}");
}

#[test]
fn an_import_create_that_cannot_happen_names_the_file_and_never_talks_of_an_export() {
    let b = project("apply-exists");
    let steps = both_steps();
    // Something else created the file after the plan was made.
    let taken = b.join("assistant/context/voice").join(POLISHED);
    fs::create_dir_all(taken.parent().unwrap()).unwrap();
    fs::write(&taken, "someone else's").unwrap();
    let hooks = Hooks {
        after_write: |_| Ok(()),
        restore: |_| Ok(()),
    };
    let error = apply_with(&b, &steps, &hooks).unwrap_err();
    assert!(
        error.starts_with(&format!("Cannot save `{POLISHED}`; nothing was replaced (")),
        "{error}"
    );
    assert!(!error.contains("export"), "{error}");
    assert!(!error.contains(&*b.to_string_lossy()), "{error}");
    assert_eq!(fs::read_to_string(&taken).unwrap(), "someone else's");
}

#[test]
fn a_plan_writes_rough_drafts_before_their_polished_partner() {
    let b = project("order");
    let polished = Item {
        visibility: "portable".into(),
        file: POLISHED.into(),
        content: sample(VoiceStage::Polished, "Words."),
    };
    let rough = Item {
        visibility: "portable".into(),
        file: ROUGH.into(),
        content: sample(VoiceStage::Rough, "words"),
    };
    let bundle = exchange::export(&[polished, rough], None);
    let (steps, problems) = plan(&b, &bundle, false, false).unwrap();
    assert!(problems.is_empty(), "{problems:?}");
    let files: Vec<_> = steps.iter().filter_map(|s| s.file.as_deref()).collect();
    assert_eq!(files, [ROUGH, POLISHED]);
}

#[test]
fn a_write_import_waits_on_the_content_transaction_lock() {
    let b = project("txn");
    put_guide(
        &b,
        Visibility::Portable,
        "# Voice guide
",
    );
    let source = project("txn-src");
    put_guide(
        &source,
        Visibility::Portable,
        "# Voice guide

Changed.
",
    );
    let file = exported(&source, false);
    let held = crate::transaction::ContentTransactionLock::acquire(&b).unwrap();
    let mut opts = options(&file, true);
    opts.overwrite = true;
    // The lock is held, so the write is refused rather than racing an Admin save.
    assert!(import(&b, &opts).is_err());
    assert_eq!(
        fs::read(b.join(PORTABLE_GUIDE)).unwrap(),
        b"# Voice guide
"
    );
    drop(held);
    import(&b, &opts).unwrap();
    assert_eq!(
        fs::read(b.join(PORTABLE_GUIDE)).unwrap(),
        b"# Voice guide

Changed.
"
    );
}

#[test]
fn one_guide_travels_and_the_private_one_left_out_is_named() {
    let a = project("two-guides");
    put_guide(&a, Visibility::Portable, "# Guide\nportable guide\n");
    put_guide(&a, Visibility::Private, "# Guide\nprivate guide\n");
    let ((text, _, guide), left_out) = collect(&a, true).unwrap();
    assert!(guide);
    assert!(text.contains("portable guide") && !text.contains("private guide"));
    assert_eq!(
        left_out,
        ["the private voice guide (one guide travels, and the portable one is preferred)"]
    );
    // Without --include-private the private guide is not offered, so nothing is said about it.
    let ((_, _, guide), left_out) = collect(&a, false).unwrap();
    assert!(guide);
    assert!(left_out.is_empty(), "{left_out:?}");
}

#[test]
fn a_library_larger_than_one_export_is_refused_whole_and_nothing_is_written() {
    let a = project("too-many");
    for n in 0..=exchange::MAX_SAMPLES {
        let file = format!(
            "2025-{:02}-{:02}-a-mistake-i-made-rough.md",
            1 + n / 28,
            1 + n % 28
        );
        put(
            &a,
            Visibility::Portable,
            &file,
            &sample(VoiceStage::Rough, "words").replace(
                "2026-10-28T09:30:00Z",
                &format!("{}T09:30:00Z", &file[..10]),
            ),
        );
    }
    let listed = voice_store::list(&a);
    assert_eq!(listed.len(), exchange::MAX_SAMPLES + 1);
    assert!(
        listed.iter().all(|l| l.valid),
        "{:?}",
        listed
            .iter()
            .find(|l| !l.valid)
            .and_then(|l| l.guidance.clone())
    );
    let error = collect(&a, false).unwrap_err();
    assert!(
        error.contains("larger than one export holds (100 samples, 8 MiB)"),
        "{error}"
    );
    let before = tree(&a);
    let error = export(&a, &options("library.json", true)).unwrap_err();
    assert!(error.contains("larger than one export holds"), "{error}");
    assert_eq!(tree(&a), before, "nothing was written");
}
