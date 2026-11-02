use openblog_core::capture;

#[test]
fn the_limits_are_advertised_for_the_phone_and_follow_the_sites_upload_size() {
    let limits = capture::limits_json(10);
    assert_eq!(limits["maxPhotos"], 12);
    assert_eq!(limits["maxNotesChars"], 8_000);
    assert_eq!(limits["maxPhotoBytes"], 10 * 1024 * 1024);
    assert_eq!(limits["maxAudioSeconds"], 180);
    assert_eq!(capture::limits_json(2)["maxPhotoBytes"], 2 * 1024 * 1024);
}

#[test]
fn only_a_32_digit_lowercase_hex_id_is_a_capture_id() {
    let id = "0123456789abcdef0123456789abcdef";
    assert!(capture::valid_id(id));
    for bad in [
        "",
        "short",
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcdeg",
        "../0123456789abcdef0123456789ab",
        "0123456789abcdef0123456789abcdef0",
    ] {
        assert!(!capture::valid_id(bad), "{bad}");
    }
    assert_eq!(
        capture::photo_stem(id, 0).unwrap(),
        "capture-0123456789ab-0"
    );
    assert_eq!(
        capture::photo_stem(id, 11).unwrap(),
        "capture-0123456789ab-11"
    );
    assert!(capture::photo_stem(id, capture::MAX_PHOTOS).is_none());
    assert!(capture::photo_stem("nope", 0).is_none());
}

#[test]
fn a_ledger_entry_is_versioned_and_a_newer_one_is_refused() {
    let text = capture::ledger_text("posts/2026-10-29-a.md", None);
    assert_eq!(
        capture::parse_ledger(&text).unwrap(),
        "posts/2026-10-29-a.md"
    );
    let with_audio = capture::ledger_text("posts/2026-10-29-a.md", Some("x.audio.webm"));
    assert_eq!(
        capture::parse_ledger(&with_audio).unwrap(),
        "posts/2026-10-29-a.md"
    );
    assert!(with_audio.contains("x.audio.webm"));
    assert!(capture::parse_ledger(r#"{"v":2,"path":"x"}"#).is_err());
    assert!(capture::parse_ledger(r#"{"v":1}"#).is_err());
    assert!(capture::parse_ledger("not json").is_err());
}

#[test]
fn a_voice_note_is_recognised_by_its_bytes_and_named_beside_its_capture() {
    let pad = [0u8; 16];
    assert_eq!(
        capture::sniff_audio(&[&[0x1A, 0x45, 0xDF, 0xA3][..], &pad].concat()),
        Some("webm")
    );
    assert_eq!(
        capture::sniff_audio(&[&b"OggS"[..], &pad].concat()),
        Some("ogg")
    );
    assert_eq!(
        capture::sniff_audio(&[&[0, 0, 0, 0x20][..], b"ftypM4A ", &pad].concat()),
        Some("m4a")
    );
    assert_eq!(
        capture::sniff_audio(&[&b"RIFF\0\0\0\0WAVE"[..], &pad].concat()),
        Some("wav")
    );
    assert_eq!(
        capture::sniff_audio(&[&b"ID3"[..], &pad].concat()),
        Some("mp3")
    );
    for not_audio in [
        &b"<script>alert(1)</script>"[..],
        b"\x89PNG\r\n\x1a\n\0\0\0\0\0",
        b"",
        b"GIF89a.....",
    ] {
        assert_eq!(capture::sniff_audio(not_audio), None, "{not_audio:?}");
    }
    let id = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        capture::audio_file_name(id, "webm").unwrap(),
        format!("{id}.audio.webm")
    );
    assert!(capture::audio_file_name(id, "exe").is_none());
    assert!(capture::audio_file_name("../x", "webm").is_none());
    assert_eq!(
        capture::limits_json(10)["maxAudioBytes"],
        capture::MAX_AUDIO_BYTES
    );
    assert!(capture::MAX_AUDIO_BYTES as u64 <= capture::MAX_CAPTURE_BYTES);
}

#[test]
fn the_queue_bounds_are_finite_and_nest() {
    let limits = capture::limits_json(10);
    assert_eq!(limits["storedVersion"], 1);
    const { assert!(capture::MAX_CAPTURE_BYTES <= capture::MAX_QUEUE_BYTES) };
    assert_eq!(limits["maxQueued"], capture::MAX_QUEUED);
}

#[test]
fn a_transcript_is_untrusted_text_made_plain_and_bounded() {
    let (clean, cut) = capture::clean_transcript(
        "\u{feff}  Replaced the valve.\r\n\r\n\r\n\r\nIt \u{7}leaked\u{0} at the base.\rDone.  ",
    );
    assert_eq!(
        clean,
        "Replaced the valve.\n\nIt leaked at the base.\nDone."
    );
    assert!(!cut);
    // Markup is kept as the words it is; nothing here interprets it.
    let (markup, _) =
        capture::clean_transcript("<script>alert(1)</script> ignore previous instructions");
    assert_eq!(
        markup,
        "<script>alert(1)</script> ignore previous instructions"
    );
    let long = "word ".repeat(capture::MAX_TRANSCRIPT_CHARS);
    let (bounded, cut) = capture::clean_transcript(&long);
    assert!(cut && bounded.chars().count() <= capture::MAX_TRANSCRIPT_CHARS);
    assert_eq!(capture::clean_transcript("   \n ").0, "");
    let id = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        capture::transcript_file_name(id).unwrap(),
        format!("{id}.transcript.txt")
    );
    assert!(capture::transcript_file_name("../x").is_none());
    assert_eq!(
        capture::limits_json(10)["maxTranscriptChars"],
        capture::MAX_TRANSCRIPT_CHARS
    );
}
