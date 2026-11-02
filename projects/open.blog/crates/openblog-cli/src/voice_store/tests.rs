use std::collections::BTreeMap;

use openblog_core::voice::{VoiceMeta, VoiceSample, VoiceStage};

use super::*;

use super::tests_support::Project;

pub(super) const ROUGH: &str = "2026-10-28-a-mistake-i-made-rough.md";
pub(super) const POLISHED: &str = "2026-10-28-a-mistake-i-made-polished.md";

pub(super) fn rough(body: &str) -> VoiceSample {
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
            stage: VoiceStage::Rough,
            time_limit_seconds: 180,
            words: voice::count_words(body),
            rough_of: None,
        },
        body: body.into(),
        extra: BTreeMap::new(),
    }
}

pub(super) fn polished(body: &str) -> VoiceSample {
    let mut sample = rough(body);
    sample.voice.stage = VoiceStage::Polished;
    sample.voice.time_limit_seconds = 0;
    sample.voice.rough_of = Some(ROUGH.into());
    sample
}

const MESSY: &str = "so i delted the wrong foldr and\r\nthen  i panicked   lol";

fn lock_rough(project: &Project, vis: Visibility) -> Written {
    write_rough(
        &project.0,
        vis,
        &rough(MESSY.replace("\r\n", "\n").as_str()),
    )
    .unwrap()
}

#[test]
fn a_project_without_samples_is_untouched_by_every_read() {
    let project = Project::new();
    let before = fsutil::walk(&project.0).len();
    assert!(list(&project.0).is_empty());
    assert!(library(&project.0).is_empty());
    assert!(read(&project.0, Visibility::Private, ROUGH).is_err());
    let catalog = load_catalog(&project.0);
    assert!(catalog.warnings.is_empty() && catalog.prompts().count() >= 40);
    assert_eq!(open_session_prompt(&project.0), None);
    assert_eq!(fsutil::walk(&project.0).len(), before);
    assert!(!project.0.join("assistant").exists());
    assert!(!project.0.join(".openblog").exists());
}

#[test]
fn a_rough_draft_needs_an_open_session_for_that_prompt() {
    let project = Project::new();
    let error = write_rough(&project.0, Visibility::Private, &rough("words")).unwrap_err();
    assert!(error.to_string().contains("no session is open"), "{error}");
    assert!(!project.0.join(".openblog/private/context").exists());
    project.open_session("another-prompt");
    let error = write_rough(&project.0, Visibility::Private, &rough("words")).unwrap_err();
    assert!(error.to_string().contains("different prompt"), "{error}");
    project.open_session("a-mistake-i-made");
    let written = write_rough(&project.0, Visibility::Private, &rough("words")).unwrap();
    assert_eq!((written.file.as_str(), written.created), (ROUGH, true));
    assert!(project
        .0
        .join(".openblog/private/context/voice")
        .join(ROUGH)
        .is_file());
}

#[test]
fn a_locked_rough_draft_refuses_every_later_write_with_a_plain_sentence() {
    let project = Project::with_session("a-mistake-i-made");
    let first = lock_rough(&project, Visibility::Portable);
    let path = project.0.join("assistant/context/voice").join(ROUGH);
    let original = fs::read(&path).unwrap();

    // Another rough write with different text: refused, file untouched.
    let error =
        write_rough(&project.0, Visibility::Portable, &rough("corrected text")).unwrap_err();
    assert_eq!(
        error,
        StoreError::Refused("This rough draft is locked. A rough draft is never changed after its session ends; polish a copy instead.".into())
    );
    // Even with the session still open, and with the old revision in hand.
    assert_eq!(fs::read(&path).unwrap(), original);
    // The polished writer refuses rough samples and cannot reach a rough file.
    let error = write_polished(
        &project.0,
        Visibility::Portable,
        &rough("x"),
        Some(&first.revision),
    )
    .unwrap_err();
    assert!(error.to_string().contains("never rewritten"), "{error}");
    // Writing the very same bytes again (a repeated lock) is a harmless no-op.
    let again = write_rough(
        &project.0,
        Visibility::Portable,
        &rough(&MESSY.replace("\r\n", "\n")),
    )
    .unwrap();
    assert!(!again.created);
    assert_eq!(again.revision, first.revision);
    assert_eq!(fs::read(&path).unwrap(), original);
    // And after the session closes, nothing can write it at all.
    project.close_session();
    assert!(write_rough(&project.0, Visibility::Portable, &rough("later")).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn the_rough_text_is_kept_exactly_including_typos_and_spacing() {
    let project = Project::with_session("a-mistake-i-made");
    let body = "  so i delted  the wrong foldr\n\n\tthen i panicked   lol  \n\n";
    write_rough(&project.0, Visibility::Private, &rough(body)).unwrap();
    let loaded = read(&project.0, Visibility::Private, ROUGH).unwrap();
    assert_eq!(loaded.sample.unwrap().body, body);
}

#[test]
fn a_rough_draft_is_not_split_across_folders() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    let error = write_rough(&project.0, Visibility::Portable, &rough("other words")).unwrap_err();
    assert!(error.to_string().contains("other folder"), "{error}");
}

#[test]
fn a_polished_draft_needs_an_existing_rough_draft() {
    let project = Project::new();
    let error =
        write_polished(&project.0, Visibility::Private, &polished("Clean."), None).unwrap_err();
    assert!(error.to_string().contains("does not exist"), "{error}");
    assert!(!project.0.join(".openblog/private/context/voice").exists());
    // A rough draft in the other folder does not count.
    project.open_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Portable);
    assert!(write_polished(&project.0, Visibility::Private, &polished("Clean."), None).is_err());
}

#[test]
fn a_polished_draft_is_created_then_updated_with_a_revision() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    let first = write_polished(&project.0, Visibility::Private, &polished("Clean."), None).unwrap();
    assert_eq!((first.file.as_str(), first.created), (POLISHED, true));

    // Creating again without a revision is stale, and says what the revision is.
    match write_polished(&project.0, Visibility::Private, &polished("Other."), None) {
        Err(StoreError::Stale { current, .. }) => assert_eq!(current, Some(first.revision.clone())),
        other => panic!("{other:?}"),
    }
    // A wrong revision is stale and writes nothing.
    match write_polished(
        &project.0,
        Visibility::Private,
        &polished("Other."),
        Some("0".repeat(64).as_str()),
    ) {
        Err(StoreError::Stale { current, message }) => {
            assert_eq!(current, Some(first.revision.clone()));
            assert!(message.contains("changed"));
        }
        other => panic!("{other:?}"),
    }
    let second = write_polished(
        &project.0,
        Visibility::Private,
        &polished("Cleaner."),
        Some(&first.revision),
    )
    .unwrap();
    assert!(!second.created && second.revision != first.revision);
    let loaded = read(&project.0, Visibility::Private, POLISHED).unwrap();
    assert_eq!(loaded.sample.unwrap().body, "Cleaner.");
    assert_eq!(loaded.listed.revision, second.revision);
    // The rough draft is still exactly as it was.
    let rough_back = read(&project.0, Visibility::Private, ROUGH).unwrap();
    assert_eq!(rough_back.sample.unwrap().body, MESSY.replace("\r\n", "\n"));
    // Nothing is left behind but the two files and the lock folder.
    let names: Vec<String> = fs::read_dir(project.0.join(".openblog/private/context/voice"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
}

#[test]
fn a_polished_write_never_replaces_a_file_that_holds_a_rough_draft() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    // A hand-made file named as the polished draft but declaring the rough stage.
    let rough_text = fs::read_to_string(
        project
            .0
            .join(".openblog/private/context/voice")
            .join(ROUGH),
    )
    .unwrap();
    let impostor = project
        .0
        .join(".openblog/private/context/voice")
        .join(POLISHED);
    fs::write(&impostor, &rough_text).unwrap();
    let current = revision(rough_text.as_bytes());
    let error = write_polished(
        &project.0,
        Visibility::Private,
        &polished("Clean."),
        Some(&current),
    )
    .unwrap_err();
    assert!(error.to_string().contains("rough draft"), "{error}");
    assert_eq!(fs::read_to_string(&impostor).unwrap(), rough_text);
}

#[test]
fn oversize_and_invalid_samples_are_refused_before_anything_is_written() {
    let project = Project::with_session("a-mistake-i-made");
    let big = "word ".repeat(MAX_BYTES / 4);
    let error = write_rough(&project.0, Visibility::Private, &rough(&big)).unwrap_err();
    assert!(error.to_string().contains("64 KiB"), "{error}");
    let mut bad = rough("fine");
    bad.slug = "Not Valid".into();
    assert!(write_rough(&project.0, Visibility::Private, &bad).is_err());
    assert!(list(&project.0).is_empty());
    assert!(!project.0.join(".openblog/private/context").exists());
}

#[test]
fn file_names_cannot_escape_or_name_other_files() {
    let project = Project::new();
    for bad in [
        "../x-rough.md",
        "..\\x-rough.md",
        "sub/2026-10-28-x-rough.md",
        "/etc/passwd",
        "author.md",
        "2026-10-28-x-rough.md.bak",
    ] {
        assert!(read(&project.0, Visibility::Private, bad).is_err(), "{bad}");
        assert!(
            move_visibility(&project.0, Visibility::Private, bad, Visibility::Portable).is_err()
        );
    }
}

#[cfg(unix)]
#[test]
fn a_symlinked_folder_cannot_redirect_a_write_outside_the_project() {
    use std::os::unix::fs::symlink;
    let project = Project::with_session("a-mistake-i-made");
    let outside = std::env::temp_dir().join(format!("ob-voice-outside-{}", std::process::id()));
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(project.0.join("assistant")).unwrap();
    symlink(&outside, project.0.join("assistant/context")).unwrap();
    let error = write_rough(&project.0, Visibility::Portable, &rough("words")).unwrap_err();
    assert!(error.to_string().contains("outside the project"), "{error}");
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    assert!(list(&project.0).is_empty());
    let _ = fs::remove_dir_all(outside);
}

#[cfg(unix)]
#[test]
fn a_symlinked_sample_file_is_listed_as_invalid_and_never_read() {
    use std::os::unix::fs::symlink;
    let project = Project::new();
    let secret = project.0.join("secret.md");
    fs::write(&secret, "secret").unwrap();
    let dir = project.0.join("assistant/context/voice");
    fs::create_dir_all(&dir).unwrap();
    symlink(&secret, dir.join(ROUGH)).unwrap();
    let listed = list(&project.0);
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].valid);
    assert!(read(&project.0, Visibility::Portable, ROUGH).is_err());
}

#[test]
fn listing_shows_stage_pack_prompt_visibility_words_date_and_keeps_invalid_files_visible() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    write_polished(
        &project.0,
        Visibility::Private,
        &polished("Clean one."),
        None,
    )
    .unwrap();
    let portable = project.0.join("assistant/context/voice");
    fs::create_dir_all(&portable).unwrap();
    fs::write(portable.join("2026-10-27-oops-rough.md"), "not a sample").unwrap();
    fs::write(portable.join("notes.md"), "stray").unwrap();
    fs::write(portable.join("ignored.txt"), "stray").unwrap();
    fs::write(portable.join(".hidden.md"), "stray").unwrap();
    let mut mismatch = rough("hello there");
    mismatch.voice.prompt = "other-prompt".into();
    fs::write(
        portable.join("2026-10-26-wrong-name-rough.md"),
        mismatch.serialize().unwrap(),
    )
    .unwrap();

    let items = list(&project.0);
    let names: Vec<&str> = items.iter().map(|i| i.file.as_str()).collect();
    assert_eq!(
        names,
        [
            "2026-10-26-wrong-name-rough.md",
            "2026-10-27-oops-rough.md",
            POLISHED,
            ROUGH,
            "notes.md"
        ]
    );
    let rough_item = items.iter().find(|i| i.file == ROUGH).unwrap();
    assert!(rough_item.valid && rough_item.guidance.is_none());
    assert_eq!(rough_item.visibility, Visibility::Private);
    assert_eq!(rough_item.stage, Some(VoiceStage::Rough));
    assert_eq!(rough_item.pack.as_deref(), Some("stories"));
    assert_eq!(rough_item.prompt.as_deref(), Some("a-mistake-i-made"));
    assert_eq!(
        rough_item.words,
        Some(openblog_core::voice::count_words(MESSY))
    );
    assert_eq!(rough_item.date.as_deref(), Some("2026-10-28T09:30:00Z"));
    let polished_item = items.iter().find(|i| i.file == POLISHED).unwrap();
    assert_eq!(polished_item.rough_of.as_deref(), Some(ROUGH));
    for invalid in [
        "2026-10-26-wrong-name-rough.md",
        "2026-10-27-oops-rough.md",
        "notes.md",
    ] {
        let item = items.iter().find(|i| i.file == invalid).unwrap();
        assert!(!item.valid, "{invalid}");
        assert!(
            item.guidance
                .as_deref()
                .is_some_and(|g| g.contains("Repair") || g.contains("Rename") || g.contains("Fix")),
            "{:?}",
            item.guidance
        );
    }
    // Only valid samples count toward coverage.
    let coverage = library(&project.0);
    assert_eq!(coverage.len(), 2);
}

#[test]
fn a_polished_draft_without_its_rough_draft_is_flagged() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    write_polished(&project.0, Visibility::Private, &polished("Clean."), None).unwrap();
    fs::remove_file(
        project
            .0
            .join(".openblog/private/context/voice")
            .join(ROUGH),
    )
    .unwrap();
    let item = &list(&project.0)[0];
    assert!(!item.valid);
    assert!(item.guidance.as_deref().unwrap().contains(ROUGH));
}

#[test]
fn a_non_utf8_or_oversize_file_is_listed_with_repair_guidance() {
    let project = Project::new();
    let dir = project.0.join("assistant/context/voice");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(ROUGH), [0xff, 0xfe, 0x00]).unwrap();
    fs::write(
        dir.join("2026-10-29-x-rough.md"),
        vec![b'a'; MAX_BYTES + 10],
    )
    .unwrap();
    let items = list(&project.0);
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| !i.valid));
    assert!(items[0].guidance.as_deref().unwrap().contains("UTF-8"));
    assert!(items[1].guidance.as_deref().unwrap().contains("64 KiB"));
}

#[test]
fn moving_copies_the_bytes_unchanged_and_moves_the_pair_together() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    write_polished(&project.0, Visibility::Private, &polished("Clean."), None).unwrap();
    let before_rough = fs::read(
        project
            .0
            .join(".openblog/private/context/voice")
            .join(ROUGH),
    )
    .unwrap();

    let moved = move_visibility(
        &project.0,
        Visibility::Private,
        POLISHED,
        Visibility::Portable,
    )
    .unwrap();
    assert_eq!(moved, [ROUGH, POLISHED]);
    let portable = project.0.join("assistant/context/voice");
    assert_eq!(fs::read(portable.join(ROUGH)).unwrap(), before_rough);
    assert!(portable.join(POLISHED).is_file());
    assert!(!project
        .0
        .join(".openblog/private/context/voice")
        .join(ROUGH)
        .exists());
    assert!(!project
        .0
        .join(".openblog/private/context/voice")
        .join(POLISHED)
        .exists());
    assert!(list(&project.0)
        .iter()
        .all(|i| i.visibility == Visibility::Portable && i.valid));

    // The moved rough draft is still locked.
    assert!(write_rough(&project.0, Visibility::Portable, &rough("edited")).is_err());
    // Moving back works; moving onto an existing file does not.
    move_visibility(&project.0, Visibility::Portable, ROUGH, Visibility::Private).unwrap();
    fs::create_dir_all(&portable).unwrap();
    fs::write(portable.join(ROUGH), "squatter").unwrap();
    let error =
        move_visibility(&project.0, Visibility::Private, ROUGH, Visibility::Portable).unwrap_err();
    assert!(error.to_string().contains("already exists"), "{error}");
    assert_eq!(
        fs::read_to_string(portable.join(ROUGH)).unwrap(),
        "squatter"
    );
    assert!(project
        .0
        .join(".openblog/private/context/voice")
        .join(ROUGH)
        .is_file());
}

#[test]
fn the_guide_lives_in_one_named_place_per_visibility() {
    let paths = guide_paths(Path::new("."));
    assert_eq!(paths.len(), 2);
    assert!(paths
        .iter()
        .any(|(v, p)| *v == Visibility::Portable && p == "assistant/context/voice.md"));
    assert!(paths
        .iter()
        .any(|(v, p)| *v == Visibility::Private && p == ".openblog/private/context/voice.md"));
}

/// A project holding every kind of thing an erase must find.
fn full_project() -> Project {
    let project = Project::with_session("a-mistake-i-made");
    let dir = &project.0;
    lock_rough(&project, Visibility::Private);
    write_polished(dir, Visibility::Private, &polished("Clean."), None).unwrap();
    let mut portable = rough("portable words");
    portable.date = "2026-10-29T09:30:00Z".into();
    project.open_session("a-mistake-i-made");
    write_rough(dir, Visibility::Portable, &portable).unwrap();
    project.open_session("a-mistake-i-made");
    for (_, relative) in guide_paths(dir) {
        let path = dir.join(&relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "guide words").unwrap();
    }
    fs::write(dir.join(".openblog/private/voice/editing-1-2.md"), "ed").unwrap();
    fs::write(dir.join(".openblog/private/voice/polishing.md"), "ed").unwrap();
    fs::write(dir.join(PRIVATE_DIR).join(".voice-x.tmp"), "half").unwrap();
    // A session record a crash left half-written holds the timed draft.
    fs::write(
        dir.join(".openblog/private/voice/.session-x.tmp"),
        "{\"draft\": \"timed words\"}",
    )
    .unwrap();
    // Not voice data: must survive.
    fs::create_dir_all(dir.join("assistant/context")).unwrap();
    fs::write(dir.join("assistant/context/author.md"), "keep me").unwrap();
    project
}

#[test]
fn the_erase_plan_names_every_kind_and_reads_only() {
    let project = full_project();
    let before = snapshot(&project.0);
    let plan = erase_plan(&project.0).unwrap();
    let kinds = |kind: EraseKind| plan.iter().filter(|i| i.kind == kind).count();
    assert_eq!(kinds(EraseKind::Sample), 3);
    assert_eq!(kinds(EraseKind::Session), 1);
    assert_eq!(kinds(EraseKind::Guide), 2);
    assert_eq!(kinds(EraseKind::EditorFile), 2);
    assert_eq!(kinds(EraseKind::Leftover), 2);
    assert!(plan.iter().all(|i| !i.path.contains("words")));
    assert_eq!(snapshot(&project.0), before);
    // A project without voice data has nothing to erase and gets no folder.
    let empty = Project::new();
    assert!(erase_plan(&empty.0).unwrap().is_empty());
    assert!(snapshot(&empty.0).is_empty());
}

#[test]
fn erasing_everything_removes_all_of_it_and_the_post_check_finds_nothing() {
    let project = full_project();
    let report = erase_all(&project.0).unwrap();
    assert_eq!(report.erased.len(), 10);
    assert!(report.remaining.is_empty(), "{:?}", report.remaining);
    assert!(erase_plan(&project.0).unwrap().is_empty());
    assert!(list(&project.0).is_empty());
    let left: Vec<String> = snapshot(&project.0).into_keys().collect();
    assert_eq!(left, ["assistant/context/author.md"], "{left:?}");
    // Repeating it is a quiet no-op.
    assert!(erase_all(&project.0).unwrap().erased.is_empty());
}

#[test]
fn a_failed_erase_puts_everything_back_exactly() {
    let project = full_project();
    let before = snapshot(&project.0);
    // Fail on the last file in plan order, after most of the others were set aside.
    let plan = erase_plan(&project.0).unwrap();
    let last = plan
        .last()
        .unwrap()
        .path
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    FAIL_ERASE.with(|f| *f.borrow_mut() = Some(last));
    let error = erase_all(&project.0).unwrap_err();
    FAIL_ERASE.with(|f| *f.borrow_mut() = None);
    assert!(error.to_string().contains("Nothing was erased"), "{error}");
    assert_eq!(snapshot(&project.0), before);
    // And it works once the obstacle is gone.
    assert!(erase_all(&project.0).unwrap().remaining.is_empty());
}

#[test]
fn a_failure_on_the_first_file_also_changes_nothing() {
    let project = full_project();
    let before = snapshot(&project.0);
    let first = erase_plan(&project.0).unwrap()[0]
        .path
        .rsplit('/')
        .next()
        .unwrap()
        .to_string();
    FAIL_ERASE.with(|f| *f.borrow_mut() = Some(first));
    assert!(erase_all(&project.0).is_err());
    FAIL_ERASE.with(|f| *f.borrow_mut() = None);
    assert_eq!(snapshot(&project.0), before);
}

/// Make a link, or `None` when this OS or user may not (Windows without the privilege).
fn try_link(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        } else {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        false
    }
}

#[test]
fn a_link_entry_is_erased_as_a_link_and_the_target_outside_the_project_survives() {
    let project = full_project();
    let outside = std::env::temp_dir().join(format!("ob-voice-link-{}.md", std::process::id()));
    fs::write(&outside, "outside words").unwrap();
    // Sorts last, so earlier entries have been set aside before it is reached.
    let link = project.0.join(PORTABLE_DIR).join("zz-link.md");
    if !try_link(&outside, &link) {
        eprintln!("skipped: this OS refused to create a link");
        let _ = fs::remove_file(&outside);
        return;
    }
    let report = erase_all(&project.0).unwrap();
    assert!(report.remaining.is_empty(), "{:?}", report.remaining);
    assert!(fs::symlink_metadata(&link).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside words");
    let left: Vec<String> = snapshot(&project.0).into_keys().collect();
    assert_eq!(left, ["assistant/context/author.md"], "{left:?}");
    let _ = fs::remove_file(&outside);
}

/// A folder link: a symlink, else a junction on Windows. `false` when neither can be made.
fn try_dir_link(target: &Path, link: &Path) -> bool {
    if try_link(target, link) {
        return true;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|out| out.status.success())
    }
    #[cfg(not(windows))]
    false
}

fn project_with_posts() -> Project {
    let project = Project::new();
    let posts = project.0.join("content/posts");
    fs::create_dir_all(&posts).unwrap();
    fs::write(posts.join("2026-01-01-keep.md"), "post words").unwrap();
    fs::write(posts.join(".hidden.tmp"), "tmp").unwrap();
    fs::create_dir_all(posts.join("erasing-old")).unwrap();
    fs::write(posts.join("erasing-old/inner.md"), "inner").unwrap();
    project
}

fn assert_posts_survive(project: &Project) {
    let posts = project.0.join("content/posts");
    assert_eq!(
        fs::read_to_string(posts.join("2026-01-01-keep.md")).unwrap(),
        "post words"
    );
    assert!(posts.join(".hidden.tmp").exists());
    assert!(posts.join("erasing-old/inner.md").exists());
}

#[test]
fn a_voice_folder_that_is_a_link_refuses_the_erase_and_touches_nothing() {
    for (voice_dir, ancestor) in [
        ("assistant/context/voice", false),
        (".openblog/private/context/voice", false),
        (".openblog/private/voice", false),
        ("assistant/context", true),
        (".openblog/private", true),
    ] {
        let project = project_with_posts();
        let link = project.0.join(voice_dir);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        if !try_dir_link(&project.0.join("content/posts"), &link) {
            eprintln!("skipped: this OS refused to create a folder link");
            return;
        }
        let before = snapshot(&project.0);
        let error = erase_all(&project.0).unwrap_err();
        assert!(
            matches!(error, StoreError::Refused(_)),
            "{voice_dir}: {error}"
        );
        assert!(
            erase_plan(&project.0).is_err(),
            "{voice_dir} (ancestor {ancestor}) must not be enumerated"
        );
        assert_posts_survive(&project);
        assert_eq!(snapshot(&project.0), before, "{voice_dir}");
    }
}

#[test]
fn a_linked_private_voice_folder_never_has_its_stale_trash_deleted() {
    let project = project_with_posts();
    let link = project.0.join(".openblog/private/voice");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    if !try_dir_link(&project.0.join("content/posts"), &link) {
        eprintln!("skipped: this OS refused to create a folder link");
        return;
    }
    assert!(erase_all(&project.0).is_err());
    assert_posts_survive(&project);
}

#[test]
fn an_erase_with_nothing_to_remove_still_cleans_stale_trash() {
    let project = Project::new();
    let stale = project
        .0
        .join(PRIVATE_VOICE_DIR_FOR_TESTS)
        .join("erasing-abc");
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("0"), "old").unwrap();
    let report = erase_all(&project.0).unwrap();
    assert!(report.erased.is_empty());
    assert!(report.remaining.is_empty(), "{:?}", report.remaining);
    assert!(!stale.exists());
}

const PRIVATE_VOICE_DIR_FOR_TESTS: &str = ".openblog/private/voice";

#[test]
fn a_post_check_that_cannot_run_says_the_files_were_erased() {
    let project = full_project();
    FAIL_CHECK.with(|f| f.set(true));
    let error = erase_all(&project.0).unwrap_err();
    FAIL_CHECK.with(|f| f.set(false));
    let text = error.to_string();
    assert!(text.contains("erased, but the check"), "{text}");
    assert!(!text.contains("Nothing was erased"), "{text}");
    let left: Vec<String> = snapshot(&project.0).into_keys().collect();
    assert_eq!(left, ["assistant/context/author.md"], "{left:?}");
}

#[test]
fn the_post_check_reports_what_it_could_not_remove() {
    let project = full_project();
    // A folder inside a sample folder is never touched, so the folder and it remain.
    fs::create_dir_all(project.0.join(PORTABLE_DIR).join("nested")).unwrap();
    fs::write(project.0.join(PORTABLE_DIR).join("nested/x.md"), "x").unwrap();
    let report = erase_all(&project.0).unwrap();
    assert_eq!(report.remaining, ["assistant/context/voice"]);
}
#[test]
fn private_writes_keep_the_private_folder_out_of_git() {
    let project = Project::with_session("a-mistake-i-made");
    fs::create_dir_all(project.0.join(".git")).unwrap();
    fs::write(project.0.join(".gitignore"), "/dist\n").unwrap();
    lock_rough(&project, Visibility::Portable);
    move_visibility(&project.0, Visibility::Portable, ROUGH, Visibility::Private).unwrap();
    assert!(fs::read_to_string(project.0.join(".gitignore"))
        .unwrap()
        .lines()
        .any(|l| l == "/.openblog/private/"));
}

#[test]
fn the_site_catalog_extends_the_bundle_and_a_broken_one_never_removes_the_feature() {
    let project = Project::new();
    let path = project.0.join(SITE_CATALOG_PATH);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "---\ndisabled: [humor]\n---\n## my-pack: My pack\n### my-prompt: Mine\nwords: 10-50\nWrite about mine.\n").unwrap();
    let catalog = load_catalog(&project.0);
    assert!(catalog.pack("humor").is_none());
    assert!(catalog.prompt("my-prompt").unwrap().site);
    assert!(catalog.warnings.is_empty());
    fs::write(
        &path,
        "## my-pack: Pack\n### a-mistake-i-made: Clash\nwords: 1-5\nx\n",
    )
    .unwrap();
    let fallback = load_catalog(&project.0);
    assert!(fallback.pack("humor").is_some());
    assert!(
        fallback.warnings[0].contains("not used"),
        "{:?}",
        fallback.warnings
    );
}

#[test]
fn revisions_are_a_stable_sha256_of_the_bytes() {
    assert_eq!(
        revision(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

// ---- Samples stay out of everything public (ADR 0266) ----

use crate::site::{self, BuildOptions};

fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fsutil::walk(dir)
        .into_iter()
        .map(|path| (fsutil::relative(dir, &path), fs::read(&path).unwrap()))
        .collect()
}

fn build_into(root: &Path, out: &Path) -> BTreeMap<String, Vec<u8>> {
    site::build(
        root,
        &BuildOptions {
            include_drafts: false,
            out_override: Some(out.to_path_buf()),
            now: None,
        },
    )
    .unwrap();
    snapshot(out)
}

#[test]
fn init_creates_no_voice_files_and_a_build_is_identical_with_and_without_samples() {
    let project = Project::new();
    let created = crate::scaffold::init(&project.0, Some("Voice test"), false).unwrap();
    assert!(
        created.iter().all(|path| !path.contains("voice")),
        "{created:?}"
    );
    assert!(snapshot(&project.0)
        .keys()
        .all(|path| !path.contains("voice")));

    let out = project.0.join("target-out");
    let without = build_into(&project.0, &out.join("a"));
    assert!(!without.is_empty());

    // Now the author writes samples, portable and private, with a marker in every file.
    project.open_session("a-mistake-i-made");
    let marker = "ZEBRAMARKER";
    write_rough(
        &project.0,
        Visibility::Portable,
        &rough(&format!("portable {marker} rough")),
    )
    .unwrap();
    write_polished(
        &project.0,
        Visibility::Portable,
        &polished(&format!("portable {marker} polished")),
        None,
    )
    .unwrap();
    let mut private = rough(&format!("private {marker} rough"));
    private.date = "2026-10-29T09:30:00Z".into();
    write_rough(&project.0, Visibility::Private, &private).unwrap();
    fs::create_dir_all(project.0.join(".openblog/private/voice")).unwrap();
    fs::write(
        project.0.join(".openblog/private/voice/note.json"),
        format!("{{\"draft\":\"{marker}\"}}"),
    )
    .unwrap();

    let with = build_into(&project.0, &out.join("b"));
    assert_eq!(
        without.keys().collect::<Vec<_>>(),
        with.keys().collect::<Vec<_>>()
    );
    for (path, bytes) in &with {
        assert_eq!(
            &without[path], bytes,
            "{path} changed because samples exist"
        );
        assert!(
            !String::from_utf8_lossy(bytes).contains(marker),
            "{path} leaks a sample"
        );
    }
    // Also a preview build that includes drafts.
    let drafts = project.0.join("target-out/c");
    site::build(
        &project.0,
        &BuildOptions {
            include_drafts: true,
            out_override: Some(drafts.clone()),
            now: None,
        },
    )
    .unwrap();
    assert!(snapshot(&drafts)
        .values()
        .all(|bytes| !String::from_utf8_lossy(bytes).contains(marker)));
}

#[test]
fn publishing_never_stages_a_private_voice_sample() {
    use crate::git::Git;
    let project = Project::new();
    let dir = &project.0;
    crate::scaffold::init(dir, Some("P"), false).unwrap();
    let git = Git::new(dir);
    git.init().unwrap();
    git.run(&["config", "user.email", "t@example.com"]).unwrap();
    git.run(&["config", "user.name", "T"]).unwrap();
    git.run(&["config", "commit.gpgsign", "false"]).unwrap();
    fs::write(dir.join(".gitignore"), "/dist\n").unwrap();
    project.open_session("a-mistake-i-made");
    write_rough(dir, Visibility::Private, &rough("private words")).unwrap();
    let mut portable = rough("portable words");
    portable.date = "2026-10-29T09:30:00Z".into();
    write_rough(dir, Visibility::Portable, &portable).unwrap();
    let mut config = site::load_config(dir).unwrap();
    config.publish.paths = vec!["assistant".into(), ".openblog".into()];

    let out = crate::publish::publish(dir, &config, Some("Voice")).unwrap();
    assert!(out
        .committed
        .iter()
        .any(|path| path == "assistant/context/voice/2026-10-29-a-mistake-i-made-rough.md"));
    assert!(
        !out.committed
            .iter()
            .any(|path| path.starts_with(".openblog/")),
        "{:?}",
        out.committed
    );
    assert!(!git
        .run(&["ls-files", "--", ".openblog/private"])
        .unwrap()
        .contains("voice"));

    // If a private sample is force-added, publishing refuses.
    git.run(&[
        "add",
        "-f",
        &format!(".openblog/private/context/voice/{ROUGH}"),
    ])
    .unwrap();
    let error = crate::publish::publish(dir, &config, Some("No")).unwrap_err();
    assert!(error.contains("private assistant"), "{error}");
}

#[test]
fn a_move_is_reversible_and_a_sample_is_only_staged_while_it_is_portable() {
    use crate::git::Git;
    let project = Project::new();
    let dir = &project.0;
    crate::scaffold::init(dir, Some("P"), false).unwrap();
    let git = Git::new(dir);
    git.init().unwrap();
    git.run(&["config", "user.email", "t@example.com"]).unwrap();
    git.run(&["config", "user.name", "T"]).unwrap();
    git.run(&["config", "commit.gpgsign", "false"]).unwrap();
    fs::write(dir.join(".gitignore"), "/dist\n").unwrap();
    project.open_session("a-mistake-i-made");
    write_rough(dir, Visibility::Private, &rough("round trip words")).unwrap();
    write_polished(dir, Visibility::Private, &polished("Clean."), None).unwrap();
    let mut config = site::load_config(dir).unwrap();
    config.publish.paths = vec!["assistant".into(), ".openblog".into()];
    let voice_files = |tree: &BTreeMap<String, Vec<u8>>| -> BTreeMap<String, Vec<u8>> {
        tree.iter()
            .filter(|(path, _)| path.contains("context/voice/"))
            .map(|(path, bytes)| (path.clone(), bytes.clone()))
            .collect()
    };
    let before = voice_files(&snapshot(dir));
    assert_eq!(before.len(), 2);

    // Private: a publish commits no voice file, and the built site carries none.
    let first = crate::publish::publish(dir, &config, Some("Private")).unwrap();
    assert!(first.committed.iter().all(|path| !path.contains("voice")));
    let built = build_into(dir, &dir.join("target-out/a"));
    // Positive control: the build produced real pages, so "no marker" below says something.
    assert!(
        built.keys().any(|path| path.ends_with("index.html")),
        "{:?}",
        built.keys().collect::<Vec<_>>()
    );
    assert!(built
        .values()
        .all(|bytes| !String::from_utf8_lossy(bytes).contains("round trip words")));
    let tracked = |pathspec: &str| git.run(&["ls-files", "--", pathspec]).unwrap();
    assert!(!tracked("assistant").contains("voice"));

    // Made portable on purpose: now both files are staged.
    move_visibility(dir, Visibility::Private, ROUGH, Visibility::Portable).unwrap();
    let second = crate::publish::publish(dir, &config, Some("Portable")).unwrap();
    for name in [ROUGH, POLISHED] {
        assert!(
            second
                .committed
                .contains(&format!("assistant/context/voice/{name}")),
            "{:?}",
            second.committed
        );
    }

    // Positive control: while portable, git does track both files.
    let tracked_now = tracked("assistant");
    for name in [ROUGH, POLISHED] {
        assert!(tracked_now.contains(name), "{tracked_now}");
    }

    // Moved back: the same bytes are in the same place, and nothing private is staged. Git
    // history keeps the commit that carried the sample while it was portable; moving it back
    // stops it being tracked from now on, it does not rewrite the past.
    move_visibility(dir, Visibility::Portable, ROUGH, Visibility::Private).unwrap();
    assert_eq!(voice_files(&snapshot(dir)), before);
    assert!(!dir.join("assistant/context/voice").join(ROUGH).exists());
    let third = crate::publish::publish(dir, &config, Some("Private again")).unwrap();
    assert!(
        third
            .committed
            .iter()
            .all(|path| !path.starts_with(".openblog/")),
        "{:?}",
        third.committed
    );
    let tracked_after = git.run(&["ls-files"]).unwrap();
    assert!(!tracked_after.contains(ROUGH), "{tracked_after}");
    assert!(!tracked_after.contains(POLISHED), "{tracked_after}");
    // Positive control, and the honest limit: earlier commits still carry the file.
    let history = git.run(&["log", "--all", "--name-only"]).unwrap();
    assert!(history.contains(ROUGH), "{history}");
    let rebuilt = build_into(dir, &dir.join("target-out/b"));
    assert!(rebuilt.keys().any(|path| path.ends_with("index.html")));
    assert!(rebuilt
        .values()
        .all(|bytes| !String::from_utf8_lossy(bytes).contains("round trip words")));
}

const PRIVATE_DIR: &str = ".openblog/private/context/voice";
const PORTABLE_DIR: &str = "assistant/context/voice";

#[test]
fn a_failed_original_removal_never_costs_the_rough_draft_and_the_move_can_be_finished() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    write_polished(&project.0, Visibility::Private, &polished("Clean."), None).unwrap();
    let private = project.0.join(PRIVATE_DIR);
    let portable = project.0.join("assistant/context/voice");
    let rough_bytes = fs::read(private.join(ROUGH)).unwrap();

    FAIL_REMOVE.with(|f| *f.borrow_mut() = Some(POLISHED.to_string()));
    let error =
        move_visibility(&project.0, Visibility::Private, ROUGH, Visibility::Portable).unwrap_err();
    FAIL_REMOVE.with(|f| *f.borrow_mut() = None);
    // The polished original is removed first, so nothing was lost yet: the copies are undone
    // and every original, the rough draft included, is untouched.
    assert!(error.to_string().contains("Cannot remove"), "{error}");
    assert_eq!(fs::read(private.join(ROUGH)).unwrap(), rough_bytes);
    assert!(private.join(POLISHED).is_file());
    assert!(!portable.join(ROUGH).exists());

    // A failure after the polished original is gone keeps the copies too.
    FAIL_REMOVE.with(|f| *f.borrow_mut() = Some(ROUGH.to_string()));
    let error =
        move_visibility(&project.0, Visibility::Private, ROUGH, Visibility::Portable).unwrap_err();
    FAIL_REMOVE.with(|f| *f.borrow_mut() = None);
    assert!(error.to_string().contains("partly done"), "{error}");
    assert!(!private.join(POLISHED).exists());
    assert!(portable.join(POLISHED).is_file());
    assert_eq!(fs::read(private.join(ROUGH)).unwrap(), rough_bytes);
    assert_eq!(fs::read(portable.join(ROUGH)).unwrap(), rough_bytes);

    // Repeating the move finishes it: identical copies already there count as moved.
    let moved =
        move_visibility(&project.0, Visibility::Private, ROUGH, Visibility::Portable).unwrap();
    assert_eq!(moved, [ROUGH]);
    assert!(!private.join(ROUGH).exists());
    assert_eq!(fs::read(portable.join(ROUGH)).unwrap(), rough_bytes);
    assert!(portable.join(POLISHED).is_file());
}

#[test]
fn a_polished_draft_this_release_cannot_read_is_never_overwritten() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    let path = project.0.join(PRIVATE_DIR).join(POLISHED);
    let first = polished("Clean.");
    write_polished(&project.0, Visibility::Private, &first, None).unwrap();
    let text = fs::read_to_string(&path)
        .unwrap()
        .replace("voice.format: 1", "voice.format: 2");
    assert!(text.contains("voice.format: 2"));
    fs::write(&path, &text).unwrap();
    let error = write_polished(
        &project.0,
        Visibility::Private,
        &polished("Cleaner."),
        Some(&revision(text.as_bytes())),
    )
    .unwrap_err();
    assert!(matches!(error, StoreError::Refused(_)), "{error}");
    assert!(error.to_string().contains("newer"), "{error}");
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
}

#[test]
fn saving_a_polished_draft_keeps_keys_a_newer_release_added() {
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    let mut first = polished("Clean.");
    first.extra.insert(
        "futureKey".into(),
        openblog_core::frontmatter::Value::Scalar("kept".into()),
    );
    let written = write_polished(&project.0, Visibility::Private, &first, None).unwrap();
    write_polished(
        &project.0,
        Visibility::Private,
        &polished("Cleaner."),
        Some(&written.revision),
    )
    .unwrap();
    let saved = fs::read_to_string(project.0.join(PRIVATE_DIR).join(POLISHED)).unwrap();
    assert!(saved.contains("futureKey: kept"), "{saved}");
    assert!(saved.contains("Cleaner."));
}

#[test]
fn writing_a_private_sample_keeps_the_private_folder_out_of_git_whatever_the_session_said() {
    let project = Project::with_session("a-mistake-i-made");
    fs::create_dir_all(project.0.join(".git")).unwrap();
    let ignored = |project: &Project| {
        fs::read_to_string(project.0.join(".gitignore"))
            .map(|t| t.lines().any(|l| l == "/.openblog/private/"))
            .unwrap_or(false)
    };
    // A portable write does not touch .gitignore.
    lock_rough(&project, Visibility::Portable);
    assert!(!ignored(&project));
    // A private polished write does.
    fs::remove_file(project.0.join("assistant/context/voice").join(ROUGH)).unwrap();
    lock_rough(&project, Visibility::Private);
    fs::remove_file(project.0.join(".gitignore")).ok();
    write_polished(&project.0, Visibility::Private, &polished("Clean."), None).unwrap();
    assert!(ignored(&project));
}

#[test]
fn locking_with_a_private_override_on_a_portable_session_keeps_the_folder_out_of_git() {
    use crate::voice_session;
    use openblog_core::DateTime;
    let project = Project::new();
    fs::create_dir_all(project.0.join(".git")).unwrap();
    let catalog = Catalog::parse_bundled(crate::voice_prompts::BUNDLED).unwrap();
    let t = |s: i64| DateTime::from_unix(1_792_000_000 + s);
    voice_session::start(
        &project.0,
        &catalog,
        "a-mistake-i-made",
        "cli",
        Visibility::Portable,
        180,
        t(0),
    )
    .unwrap();
    voice_session::save_draft(&project.0, None, "words", t(5)).unwrap();
    let ignore_path = project.0.join(".gitignore");
    fs::write(&ignore_path, "/dist\n").unwrap();
    voice_session::lock(
        &project.0,
        None,
        &catalog,
        None,
        Some(Visibility::Private),
        t(10),
    )
    .unwrap();
    assert!(fs::read_to_string(&ignore_path)
        .unwrap()
        .lines()
        .any(|l| l == "/.openblog/private/"));
}

#[test]
fn a_portable_export_never_carries_a_voice_sample() {
    let project = Project::new();
    crate::scaffold::init(&project.0, Some("Voice test"), false).unwrap();
    project.open_session("a-mistake-i-made");
    let marker = "ZEBRAEXPORT";
    write_rough(
        &project.0,
        Visibility::Portable,
        &rough(&format!("portable {marker} rough")),
    )
    .unwrap();
    let mut private = rough(&format!("private {marker} rough"));
    private.date = "2026-10-29T09:30:00Z".into();
    write_rough(&project.0, Visibility::Private, &private).unwrap();
    let out = project.0.join("exports").join("a.md");
    crate::portable_export::run(
        &project.0,
        "hello-world",
        crate::portable_export::Format::Markdown,
        Some(out.to_str().unwrap()),
        true,
        false,
    )
    .unwrap();
    let text = fs::read_to_string(&out).unwrap();
    assert!(!text.contains(marker), "the export leaks a sample");
}

// ---- promotion to a post draft -----------------------------------------------------------

fn site_project() -> Project {
    let project = Project::with_session("a-mistake-i-made");
    crate::scaffold::init(&project.0, Some("T"), false).unwrap();
    project
}

fn with_polished(project: &Project, vis: Visibility) {
    write_rough(&project.0, vis, &rough("so i delted the foldr")).unwrap();
    write_polished(&project.0, vis, &polished("So I deleted the folder."), None).unwrap();
}

fn tree_bytes(project: &Project, dir: &str) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> = fsutil::walk(&project.0.join(dir))
        .into_iter()
        .map(|p| (p.display().to_string(), fs::read(&p).unwrap()))
        .collect();
    out.sort();
    out
}

#[test]
fn promoting_a_polished_draft_creates_a_valid_post_draft_and_leaves_the_samples_alone() {
    for vis in [Visibility::Private, Visibility::Portable] {
        let project = site_project();
        with_polished(&project, vis);
        let before = tree_bytes(&project, vis.directory());
        let created = promote_to_post_draft(&project.0, vis, POLISHED, None).unwrap();
        assert_eq!(
            created.to_str().unwrap(),
            "content/posts/2026-10-28-a-mistake-i-made.md"
        );
        let text = fs::read_to_string(project.0.join(&created)).unwrap();
        assert!(
            text.contains("draft: \"true\"") && text.contains("So I deleted the folder."),
            "{text}"
        );
        assert!(!text.contains("voice"), "{text}");
        assert_eq!(tree_bytes(&project, vis.directory()), before);
        // The ordinary loader accepts it; as a draft it is held back from a normal build.
        let (site, _) = crate::site::load_site(&project.0, true, None).unwrap();
        assert!(site
            .posts
            .iter()
            .any(|p| p.slug == "a-mistake-i-made" && p.draft));
    }
}

#[test]
fn promotion_refuses_a_rough_draft_and_writes_nothing() {
    let project = site_project();
    with_polished(&project, Visibility::Private);
    let error = promote_to_post_draft(&project.0, Visibility::Private, ROUGH, None).unwrap_err();
    assert!(
        error.to_string().contains("Polish this rough draft first"),
        "{error}"
    );
    assert!(!project
        .0
        .join("content/posts/2026-10-28-a-mistake-i-made.md")
        .exists());
}

#[test]
fn promotion_refuses_a_taken_slug_even_a_draft_with_a_different_file_name() {
    let project = site_project();
    with_polished(&project, Visibility::Private);
    fs::write(
        project.0.join("content/posts/2020-01-01-old.md"),
        "---\ntitle: Old\nslug: a-mistake-i-made\ndate: 2020-01-01\ndraft: true\n---\n\nBody.\n",
    )
    .unwrap();
    let error = promote_to_post_draft(&project.0, Visibility::Private, POLISHED, None).unwrap_err();
    assert!(error.to_string().contains("a-mistake-i-made"), "{error}");
    assert!(!project
        .0
        .join("content/posts/2026-10-28-a-mistake-i-made.md")
        .exists());
}

#[test]
fn promotion_never_replaces_a_file_and_keeps_to_the_posts_folder() {
    let project = site_project();
    with_polished(&project, Visibility::Private);
    promote_to_post_draft(
        &project.0,
        Visibility::Private,
        POLISHED,
        Some("posts/2026"),
    )
    .unwrap();
    let again = promote_to_post_draft(&project.0, Visibility::Private, POLISHED, None).unwrap_err();
    assert!(again.to_string().contains("already exists"), "{again}");
    for bad in [
        "../outside",
        "pages",
        "posts/../pages",
        "/abs",
        "posts\\x",
        "posts/_hidden",
        "",
    ] {
        let error = promote_to_post_draft(&project.0, Visibility::Private, POLISHED, Some(bad))
            .unwrap_err();
        assert!(error.to_string().contains("posts"), "{bad}: {error}");
    }
}

#[test]
fn a_voice_folder_linked_inside_the_project_is_never_written_to() {
    let project = project_with_posts();
    project.open_session("a-mistake-i-made");
    let link = project.0.join(Visibility::Private.directory());
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    if !try_dir_link(&project.0.join("content/posts"), &link) {
        eprintln!("skipped: this OS refused to create a folder link");
        return;
    }
    let before = snapshot(&project.0);
    let error = write_rough(&project.0, Visibility::Private, &rough("words")).unwrap_err();
    assert!(matches!(error, StoreError::Refused(_)), "{error}");
    assert!(error.to_string().contains("is a link"), "{error}");
    assert!(write_polished(&project.0, Visibility::Private, &polished("Clean."), None).is_err());
    assert_posts_survive(&project);
    assert_eq!(snapshot(&project.0), before);
}

// ---- moving the voice guide (ADR 0289) ---------------------------------------------------------

const PORTABLE_GUIDE: &str = "assistant/context/voice.md";
const PRIVATE_GUIDE: &str = ".openblog/private/context/voice.md";
const GUIDE_TEXT: &str =
    "# Voice guide\n<!-- openblog:voice-provenance sources=portable -->\n\n- Mine\n";

fn put(project: &Project, relative: &str, bytes: &[u8]) {
    let path = project.0.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn the_guide_moves_both_ways_unchanged_and_private_is_kept_out_of_git() {
    let project = Project::new();
    fs::create_dir_all(project.0.join(".git")).unwrap();
    put(&project, PORTABLE_GUIDE, GUIDE_TEXT.as_bytes());

    let planned = plan_guide_move(&project.0, Visibility::Private).unwrap();
    assert_eq!(planned.from_path, PORTABLE_GUIDE);
    assert_eq!(planned.to_path, PRIVATE_GUIDE);
    assert_eq!(planned.bytes, GUIDE_TEXT.len());
    assert!(!planned.finishing);
    // A plan writes nothing.
    assert!(!project.0.join(PRIVATE_GUIDE).exists());

    move_guide(&project.0, Visibility::Private).unwrap();
    assert!(!project.0.join(PORTABLE_GUIDE).exists());
    assert_eq!(
        fs::read_to_string(project.0.join(PRIVATE_GUIDE)).unwrap(),
        GUIDE_TEXT
    );
    assert!(fs::read_to_string(project.0.join(".gitignore"))
        .unwrap()
        .contains("/.openblog/private/"));

    // And back again: the move is reversible and the bytes never change.
    move_guide(&project.0, Visibility::Portable).unwrap();
    assert!(!project.0.join(PRIVATE_GUIDE).exists());
    assert_eq!(
        fs::read_to_string(project.0.join(PORTABLE_GUIDE)).unwrap(),
        GUIDE_TEXT
    );
}

#[test]
fn a_guide_that_quotes_private_samples_or_cannot_be_read_never_moves_to_portable() {
    for bytes in [
        b"# Voice guide\n<!-- openblog:voice-provenance sources=portable,private -->\n".to_vec(),
        vec![0xff, 0xfe, 0x00, 0x41],
        vec![b'a'; MAX_GUIDE_BYTES as usize + 1],
    ] {
        let project = Project::new();
        put(&project, PRIVATE_GUIDE, &bytes);
        let before = snapshot(&project.0);
        assert!(matches!(
            plan_guide_move(&project.0, Visibility::Portable),
            Err(StoreError::Refused(_))
        ));
        assert!(matches!(
            move_guide(&project.0, Visibility::Portable),
            Err(StoreError::Refused(_))
        ));
        assert_eq!(snapshot(&project.0), before);
    }
    // A guide that quotes private samples may of course move to private.
    let project = Project::new();
    let private = b"# Voice guide\n<!-- openblog:voice-provenance sources=private -->\n";
    put(&project, PORTABLE_GUIDE, private);
    move_guide(&project.0, Visibility::Private).unwrap();
    assert_eq!(fs::read(project.0.join(PRIVATE_GUIDE)).unwrap(), private);
}

#[test]
fn a_guide_whose_traits_cite_a_sample_that_is_private_now_never_moves_to_portable() {
    // The guide was made from portable samples, so its provenance says portable; then the sample
    // it quotes was moved to private. Its quote is private text now.
    let project = Project::with_session("a-mistake-i-made");
    lock_rough(&project, Visibility::Private);
    let guide = format!(
        "# Voice guide
<!-- openblog:voice-provenance sources=portable -->

## Word choice

- Casual: \"panicked\" ({ROUGH})
"
    );
    put(&project, PRIVATE_GUIDE, guide.as_bytes());
    assert!(guide_is_private_derived(&project.0, &guide));
    let before = snapshot(&project.0);
    assert!(matches!(
        plan_guide_move(&project.0, Visibility::Portable),
        Err(StoreError::Refused(message)) if message.contains("private samples")
    ));
    assert!(matches!(
        move_guide(&project.0, Visibility::Portable),
        Err(StoreError::Refused(_))
    ));
    assert_eq!(snapshot(&project.0), before);

    // Once the sample is portable again, the guide may follow it.
    move_visibility(&project.0, Visibility::Private, ROUGH, Visibility::Portable).unwrap();
    assert!(!guide_is_private_derived(&project.0, &guide));
    move_guide(&project.0, Visibility::Portable).unwrap();
    assert_eq!(
        fs::read_to_string(project.0.join(PORTABLE_GUIDE)).unwrap(),
        guide
    );
}

#[test]
fn a_guide_move_never_overwrites_and_finishes_an_interrupted_move() {
    let project = Project::new();
    assert!(matches!(
        plan_guide_move(&project.0, Visibility::Private),
        Err(StoreError::Refused(message)) if message.contains("no portable voice guide")
    ));
    put(&project, PORTABLE_GUIDE, GUIDE_TEXT.as_bytes());
    put(&project, PRIVATE_GUIDE, b"# Another guide\n");
    let before = snapshot(&project.0);
    assert!(matches!(
        move_guide(&project.0, Visibility::Private),
        Err(StoreError::Refused(message)) if message.contains("already exists")
    ));
    assert_eq!(snapshot(&project.0), before);
    // An identical copy at the destination: the move only removes the original.
    put(&project, PRIVATE_GUIDE, GUIDE_TEXT.as_bytes());
    assert!(
        plan_guide_move(&project.0, Visibility::Private)
            .unwrap()
            .finishing
    );
    move_guide(&project.0, Visibility::Private).unwrap();
    assert!(!project.0.join(PORTABLE_GUIDE).exists());
    assert_eq!(
        fs::read_to_string(project.0.join(PRIVATE_GUIDE)).unwrap(),
        GUIDE_TEXT
    );
}

#[test]
fn a_failed_removal_never_loses_the_guide_and_the_move_can_be_finished() {
    let project = Project::new();
    put(&project, PORTABLE_GUIDE, GUIDE_TEXT.as_bytes());
    FAIL_REMOVE.with(|f| *f.borrow_mut() = Some("voice.md".to_string()));
    let error = move_guide(&project.0, Visibility::Private).unwrap_err();
    FAIL_REMOVE.with(|f| *f.borrow_mut() = None);
    assert!(error.to_string().contains("run the move again"), "{error}");
    // Both copies are the guide, byte for byte.
    for path in [PORTABLE_GUIDE, PRIVATE_GUIDE] {
        assert_eq!(
            fs::read_to_string(project.0.join(path)).unwrap(),
            GUIDE_TEXT
        );
    }
    move_guide(&project.0, Visibility::Private).unwrap();
    assert!(!project.0.join(PORTABLE_GUIDE).exists());
    assert_eq!(
        fs::read_to_string(project.0.join(PRIVATE_GUIDE)).unwrap(),
        GUIDE_TEXT
    );
}

#[test]
fn a_linked_guide_or_guide_folder_refuses_the_move_and_touches_nothing() {
    // The private context folder is a link to the posts.
    let project = project_with_posts();
    put(&project, PORTABLE_GUIDE, GUIDE_TEXT.as_bytes());
    let link = project.0.join(".openblog/private/context");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    if !try_dir_link(&project.0.join("content/posts"), &link) {
        eprintln!("skipped: this OS refused to create a folder link");
        return;
    }
    let before = snapshot(&project.0);
    assert!(matches!(
        move_guide(&project.0, Visibility::Private),
        Err(StoreError::Refused(message)) if message.contains("is a link")
    ));
    assert_posts_survive(&project);
    assert_eq!(snapshot(&project.0), before);

    // The guide itself is a link to a file outside the project.
    let project = Project::new();
    let outside = std::env::temp_dir().join(format!("ob-voice-guide-{}.md", std::process::id()));
    fs::write(&outside, "outside words").unwrap();
    fs::create_dir_all(project.0.join("assistant/context")).unwrap();
    if try_link(&outside, &project.0.join(PORTABLE_GUIDE)) {
        assert!(matches!(
            move_guide(&project.0, Visibility::Private),
            Err(StoreError::Refused(_))
        ));
        assert!(!project.0.join(PRIVATE_GUIDE).exists());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside words");
    }
    let _ = fs::remove_file(&outside);
}

#[test]
fn a_create_that_cannot_happen_names_the_file_not_an_export_or_the_absolute_path() {
    let project = Project::new();
    let path = project.0.join("assistant/context/voice").join(ROUGH);
    put(
        &project,
        &format!("assistant/context/voice/{ROUGH}"),
        b"first",
    );
    let message = create_new(&path, b"second").unwrap_err().to_string();
    assert!(
        message.starts_with(&format!("Cannot save `{ROUGH}`; nothing was replaced (")),
        "{message}"
    );
    assert!(!message.contains("export"), "{message}");
    assert!(
        !message.contains(&*project.0.to_string_lossy()),
        "{message}"
    );
    assert_eq!(fs::read(&path).unwrap(), b"first");
}
