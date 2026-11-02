use super::*;
use crate::voice_store::tests_support::Project;

const T0: i64 = 1_792_000_000; // 2026-10-14T18:13:20Z

fn at(seconds: i64) -> DateTime {
    DateTime::from_unix(T0 + seconds)
}

fn catalog() -> Catalog {
    Catalog::parse_bundled(crate::voice_prompts::BUNDLED).unwrap()
}

fn begin(project: &Project, prompt: &str, visibility: Visibility) -> Session {
    start(
        &project.0,
        &catalog(),
        prompt,
        "cli",
        visibility,
        180,
        at(0),
    )
    .unwrap()
}

fn record(project: &Project) -> PathBuf {
    project.0.join(SESSION_PATH)
}

#[test]
fn starting_records_the_prompt_the_catalog_version_and_the_deadline() {
    let project = Project::new();
    let session = begin(&project, "a-mistake-i-made", Visibility::Private);
    assert_eq!(session.pack, "stories");
    assert_eq!(session.catalog_version, 1);
    assert_eq!(session.time_limit_seconds, 180);
    assert_eq!(session.started_at, at(0).rfc3339());
    assert_eq!(session.deadline, at(180).rfc3339());
    assert_eq!(session.surface, "cli");
    assert!(session.draft.is_empty());
    match status(&project.0, at(60)).unwrap() {
        Status::Active {
            session: read,
            remaining_seconds,
        } => {
            assert_eq!(read, session);
            assert_eq!(remaining_seconds, 120);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn only_one_session_is_open_and_starting_another_asks_to_lock_or_scrap() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    let before = fs::read(record(&project)).unwrap();
    let error = start(
        &project.0,
        &catalog(),
        "a-turning-point",
        "admin",
        Visibility::Private,
        180,
        at(10),
    )
    .unwrap_err();
    assert_eq!(
        error,
        StartError::AlreadyOpen {
            prompt_id: "a-mistake-i-made".into(),
            expired: false
        }
    );
    assert!(error.to_string().contains("Lock it or scrap it"));
    assert_eq!(fs::read(record(&project)).unwrap(), before);
    // Even one that has run out of time is still open until it is locked or scrapped.
    let error = start(
        &project.0,
        &catalog(),
        "a-turning-point",
        "admin",
        Visibility::Private,
        180,
        at(500),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        StartError::AlreadyOpen { expired: true, .. }
    ));
    assert!(error.to_string().contains("run out of time"));
    assert_eq!(fs::read(record(&project)).unwrap(), before);
}

#[test]
fn starting_checks_the_prompt_the_window_and_the_surface() {
    let project = Project::new();
    let go = |prompt: &str, surface: &str, seconds: u32| {
        start(
            &project.0,
            &catalog(),
            prompt,
            surface,
            Visibility::Private,
            seconds,
            at(0),
        )
    };
    assert!(go("no-such-prompt", "cli", 180).is_err());
    assert!(go("a-mistake-i-made", "cli", 5).is_err());
    assert!(go("a-mistake-i-made", "cli", 99_999).is_err());
    assert!(go("a-mistake-i-made", "Bad Surface", 180).is_err());
    assert!(!record(&project).exists());
}

#[test]
fn resuming_before_the_deadline_returns_the_remaining_time_and_the_draft() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "so i delted", at(50)).unwrap();
    match resume(&project.0, &catalog(), at(100)).unwrap() {
        Resume::Active {
            session,
            remaining_seconds,
        } => {
            assert_eq!(remaining_seconds, 80);
            assert_eq!(session.draft, "so i delted");
            assert_eq!(session.deadline, at(180).rfc3339());
        }
        other => panic!("{other:?}"),
    }
    // Resuming changes nothing, so another surface sees the same deadline.
    assert!(matches!(
        resume(&project.0, &catalog(), at(179)).unwrap(),
        Resume::Active {
            remaining_seconds: 1,
            ..
        }
    ));
    assert!(record(&project).exists());
}

#[test]
fn resuming_after_the_deadline_locks_the_rough_draft_from_the_saved_text() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(
        &project.0,
        None,
        "so i delted the wrong foldr\r\nand  panicked",
        at(170),
    )
    .unwrap();
    // The text on screen never arrived; the saved text is what gets locked, byte for byte.
    let resumed = resume(&project.0, &catalog(), at(180 + LOCK_GRACE_SECONDS + 1)).unwrap();
    let Resume::Locked(locked) = resumed else {
        panic!("{resumed:?}")
    };
    assert!(locked.expired);
    assert_eq!(locked.words, 8);
    assert!(!record(&project).exists());
    let file = voice_store::read(&project.0, Visibility::Private, &locked.written.file).unwrap();
    let sample = file.sample.unwrap();
    assert_eq!(sample.body, "so i delted the wrong foldr\nand  panicked");
    assert_eq!(sample.voice.stage, VoiceStage::Rough);
    assert_eq!(sample.voice.time_limit_seconds, 180);
    assert_eq!(sample.title, "A mistake I made");
    // And it is locked for good.
    assert!(voice_store::write_rough(&project.0, Visibility::Private, &sample).is_err());
    let mut changed = sample.clone();
    changed.body = "fixed".into();
    changed.voice.words = 1;
    assert!(voice_store::write_rough(&project.0, Visibility::Private, &changed).is_err());
}

#[test]
fn an_expired_session_with_nothing_written_is_discarded() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "   \n ", at(10)).unwrap();
    assert_eq!(
        resume(&project.0, &catalog(), at(999)).unwrap(),
        Resume::Discarded {
            prompt_id: "a-mistake-i-made".into()
        }
    );
    assert!(!record(&project).exists());
    assert!(voice_store::list(&project.0).is_empty());
    assert_eq!(
        resume(&project.0, &catalog(), at(999)).unwrap(),
        Resume::NoSession
    );
}

#[test]
fn saving_stops_at_the_deadline_and_only_the_final_lock_has_a_grace() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "one", at(100)).unwrap();
    assert!(save_draft(&project.0, None, "two", at(179)).is_ok());
    let error = save_draft(&project.0, None, "three", at(180)).unwrap_err();
    assert!(error.to_string().contains("Time is up"), "{error}");
    assert!(save_draft(&project.0, None, "four", at(180 + LOCK_GRACE_SECONDS)).is_err());
    assert!(save_draft(&project.0, None, &"x".repeat(MAX_DRAFT_BYTES + 1), at(1)).is_err());
    assert!(save_draft(&project.0, None, "a\0b", at(1)).is_err());
    match status(&project.0, at(1)).unwrap() {
        Status::Active { session, .. } => assert_eq!(session.draft, "two"),
        other => panic!("{other:?}"),
    }
    // The lock still takes the final text within the grace.
    let locked = lock(
        &project.0,
        None,
        &catalog(),
        Some("final"),
        None,
        at(180 + LOCK_GRACE_SECONDS),
    )
    .unwrap();
    assert_eq!(locked.words, 1);
}

#[test]
fn a_record_whose_deadline_exceeds_its_window_is_not_trusted() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    let text = fs::read_to_string(record(&project)).unwrap();
    let stretched = text.replace(&at(180).rfc3339(), &at(100_000).rfc3339());
    assert_ne!(text, stretched);
    fs::write(record(&project), &stretched).unwrap();
    let error = save_draft(&project.0, None, "more", at(5)).unwrap_err();
    assert!(error.to_string().contains("damaged"), "{error}");
    assert_eq!(fs::read_to_string(record(&project)).unwrap(), stretched);
}

#[test]
fn the_session_record_is_kept_out_of_git_even_for_a_portable_session() {
    let project = Project::new();
    fs::create_dir_all(project.0.join(".git")).unwrap();
    begin(&project, "a-mistake-i-made", Visibility::Portable);
    let ignore = fs::read_to_string(project.0.join(".gitignore")).unwrap();
    assert!(
        ignore.lines().any(|l| l == "/.openblog/private/"),
        "{ignore}"
    );
}

#[test]
fn a_lone_carriage_return_becomes_a_line_feed_so_the_lock_can_succeed() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "one\rtwo\r\nthree", at(5)).unwrap();
    let locked = lock(&project.0, None, &catalog(), Some("a\rb"), None, at(10)).unwrap();
    let loaded = voice_store::read(&project.0, Visibility::Private, &locked.written.file).unwrap();
    assert_eq!(loaded.sample.unwrap().body, "a\nb");
}

#[test]
fn locking_uses_the_final_text_in_time_and_the_saved_text_when_late() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Portable);
    save_draft(&project.0, None, "saved text", at(100)).unwrap();
    let locked = lock(
        &project.0,
        None,
        &catalog(),
        Some("final text on screen"),
        None,
        at(181),
    )
    .unwrap();
    assert!(locked.expired);
    let sample = voice_store::read(&project.0, Visibility::Portable, &locked.written.file)
        .unwrap()
        .sample
        .unwrap();
    assert_eq!(sample.body, "final text on screen");
    assert!(!record(&project).exists());

    let project = Project::new();
    begin(&project, "a-turning-point", Visibility::Private);
    save_draft(&project.0, None, "saved text", at(100)).unwrap();
    let locked = lock(
        &project.0,
        None,
        &catalog(),
        Some("late text"),
        Some(Visibility::Portable),
        at(400),
    )
    .unwrap();
    let sample = voice_store::read(&project.0, Visibility::Portable, &locked.written.file)
        .unwrap()
        .sample
        .unwrap();
    assert_eq!(sample.body, "saved text");
}

#[test]
fn the_record_is_removed_on_lock_and_on_scrap_and_nothing_is_written_by_a_scrap() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "words", at(5)).unwrap();
    scrap(&project.0, None).unwrap();
    assert!(!record(&project).exists());
    assert!(voice_store::list(&project.0).is_empty());
    assert_eq!(status(&project.0, at(6)).unwrap(), Status::None);
    scrap(&project.0, None).unwrap();

    begin(&project, "a-mistake-i-made", Visibility::Private);
    lock(&project.0, None, &catalog(), Some("words"), None, at(20)).unwrap();
    assert!(!record(&project).exists());
    // Locking nothing is refused and keeps the session so the author can write or scrap it.
    begin(&project, "a-turning-point", Visibility::Private);
    let error = lock(&project.0, None, &catalog(), Some("  "), None, at(30)).unwrap_err();
    assert!(error.to_string().contains("Nothing was written"), "{error}");
    assert!(record(&project).exists());
}

#[test]
fn a_prompt_cannot_be_started_twice_on_the_same_day() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    lock(&project.0, None, &catalog(), Some("words"), None, at(20)).unwrap();
    let error = start(
        &project.0,
        &catalog(),
        "a-mistake-i-made",
        "cli",
        Visibility::Private,
        180,
        at(40),
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("already wrote this prompt today"),
        "{error}"
    );
    // Tomorrow is fine.
    assert!(start(
        &project.0,
        &catalog(),
        "a-mistake-i-made",
        "cli",
        Visibility::Private,
        180,
        at(86_400 + 40),
    )
    .is_ok());
}

#[test]
fn a_repeated_lock_after_a_crash_is_harmless() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "my words", at(10)).unwrap();
    let saved = fs::read(record(&project)).unwrap();
    lock(&project.0, None, &catalog(), None, None, at(20)).unwrap();
    // The process died after writing the rough draft but before removing the record.
    fs::write(record(&project), &saved).unwrap();
    let again = lock(&project.0, None, &catalog(), None, None, at(25)).unwrap();
    assert!(!again.written.created);
    assert!(!record(&project).exists());
    assert_eq!(voice_store::list(&project.0).len(), 1);
}

#[test]
fn writes_go_through_a_temporary_file_and_a_crash_leaves_the_old_record_readable() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "first", at(5)).unwrap();
    let directory = project.0.join(".openblog/private/voice");
    // A crash during a write leaves, at worst, a temporary file; the record is untouched.
    fs::write(
        directory.join(".session-deadbeef.tmp"),
        "{\"format\": \"trunc",
    )
    .unwrap();
    match status(&project.0, at(6)).unwrap() {
        Status::Active { session, .. } => assert_eq!(session.draft, "first"),
        other => panic!("{other:?}"),
    }
    save_draft(&project.0, None, "second", at(7)).unwrap();
    // A normal write leaves no temporary file of its own behind.
    let leftovers: Vec<String> = fs::read_dir(&directory)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect();
    assert_eq!(leftovers, [".session-deadbeef.tmp"]);
    let text = fs::read_to_string(record(&project)).unwrap();
    assert!(text.contains("\"draft\": \"second\"") && text.ends_with('\n'));
}

#[test]
fn a_damaged_record_is_reported_and_can_be_scrapped_but_a_newer_one_is_never_removed() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    fs::write(record(&project), "{ not json").unwrap();
    let error = status(&project.0, at(1)).unwrap_err();
    assert!(error.to_string().contains("damaged"), "{error}");
    assert!(save_draft(&project.0, None, "x", at(1)).is_err());
    scrap(&project.0, None).unwrap();
    assert!(!record(&project).exists());

    let newer = format!(
        "{{\"format\":\"{SESSION_FORMAT}\",\"version\":2,\"promptId\":\"a-mistake-i-made\"}}"
    );
    fs::create_dir_all(record(&project).parent().unwrap()).unwrap();
    fs::write(record(&project), &newer).unwrap();
    let error = status(&project.0, at(1)).unwrap_err();
    assert!(error.to_string().contains("newer release"), "{error}");
    assert!(scrap(&project.0, None).is_err());
    assert_eq!(fs::read_to_string(record(&project)).unwrap(), newer);
}

#[test]
fn a_session_never_starts_or_touches_anything_before_it_is_asked_to() {
    let project = Project::new();
    assert_eq!(status(&project.0, at(0)).unwrap(), Status::None);
    assert_eq!(
        resume(&project.0, &catalog(), at(0)).unwrap(),
        Resume::NoSession
    );
    assert!(fs::read_dir(&project.0).unwrap().next().is_none());
}

#[test]
fn a_save_or_lock_naming_another_session_is_refused_under_the_store_lock() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    let open = match status(&project.0, at(1)).unwrap() {
        Status::Active { session, .. } => session,
        other => panic!("{other:?}"),
    };
    let error = save_draft(&project.0, Some("old@2020"), "x", at(2)).unwrap_err();
    assert!(error.to_string().contains("earlier session"), "{error}");
    let error = lock(
        &project.0,
        Some("old@2020"),
        &catalog(),
        Some("x"),
        None,
        at(3),
    )
    .unwrap_err();
    assert!(error.to_string().contains("earlier session"), "{error}");
    assert!(record(&project).exists());
    let id = open.id();
    save_draft(&project.0, Some(&id), "mine", at(4)).unwrap();
    lock(&project.0, Some(&id), &catalog(), None, None, at(5)).unwrap();
    assert!(!record(&project).exists());
}

#[test]
fn a_scrap_naming_an_earlier_session_leaves_the_newer_one_alone() {
    let project = Project::new();
    let first = begin(&project, "a-mistake-i-made", Visibility::Private);
    scrap(&project.0, Some(&first.id())).unwrap();
    let second = start(
        &project.0,
        &catalog(),
        "a-mistake-i-made",
        "cli",
        Visibility::Private,
        180,
        at(5),
    )
    .unwrap();
    save_draft(&project.0, None, "newer words", at(6)).unwrap();
    let error = scrap(&project.0, Some(&first.id())).unwrap_err();
    assert_eq!(error.to_string(), SCRAP_OTHER_SESSION);
    match status(&project.0, at(7)).unwrap() {
        Status::Active { session, .. } => {
            assert_eq!(session.id(), second.id());
            assert_eq!(session.draft, "newer words");
        }
        other => panic!("{other:?}"),
    }
    scrap(&project.0, Some(&second.id())).unwrap();
    assert_eq!(status(&project.0, at(8)).unwrap(), Status::None);
}

#[test]
fn a_rough_draft_is_never_written_for_a_session_that_was_scrapped_and_started_again() {
    let project = Project::new();
    begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "first words", at(10)).unwrap();
    // The lock read session 1; before it writes, session 1 is scrapped and session 2 starts.
    let old = match status(&project.0, at(11)).unwrap() {
        Status::Active { session, .. } => session,
        other => panic!("{other:?}"),
    };
    scrap(&project.0, None).unwrap();
    start(
        &project.0,
        &catalog(),
        "a-mistake-i-made",
        "cli",
        Visibility::Private,
        180,
        at(12),
    )
    .unwrap();
    let sample = VoiceSample {
        title: "A mistake I made".into(),
        subtitle: None,
        slug: old.prompt_id.clone(),
        date: old.started_at.clone(),
        description: None,
        tags: Vec::new(),
        voice: VoiceMeta {
            catalog: old.catalog_version,
            pack: old.pack.clone(),
            prompt: old.prompt_id.clone(),
            stage: VoiceStage::Rough,
            time_limit_seconds: old.time_limit_seconds,
            words: 2,
            rough_of: None,
        },
        body: "first words".into(),
        extra: std::collections::BTreeMap::new(),
    };
    assert!(voice_store::write_rough(&project.0, Visibility::Private, &sample).is_err());
    assert!(voice_store::list(&project.0).is_empty());
    // Session 2 still locks its own text.
    save_draft(&project.0, None, "second words", at(20)).unwrap();
    let locked = lock(&project.0, None, &catalog(), None, None, at(21)).unwrap();
    assert!(locked.written.created);
}

#[test]
fn a_resume_within_the_lock_grace_leaves_the_session_for_the_surface_that_was_writing() {
    let project = Project::new();
    let session = begin(&project, "a-mistake-i-made", Visibility::Private);
    save_draft(&project.0, None, "saved so far", at(170)).unwrap();
    assert_eq!(
        resume(&project.0, &catalog(), at(180 + LOCK_GRACE_SECONDS)).unwrap(),
        Resume::Finishing {
            session: Session {
                draft: "saved so far".into(),
                ..session
            }
        }
    );
    // The writing surface still hands over its final text.
    let locked = lock(
        &project.0,
        None,
        &catalog(),
        Some("saved so far and the last line"),
        None,
        at(185),
    )
    .unwrap();
    let file = voice_store::read(&project.0, Visibility::Private, &locked.written.file).unwrap();
    assert_eq!(file.sample.unwrap().body, "saved so far and the last line");
}
