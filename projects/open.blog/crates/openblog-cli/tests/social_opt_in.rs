//! Optional social publishing is off by default and invisible to the publishing pipeline
//! (ADR 0293): a site build, a portable export and a cross-posting plan are byte for byte the
//! same whether or not the deployment holds social publishing settings and secrets, and no such
//! secret ever reaches their output.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const SECRETS: [(&str, &str); 7] = [
    ("OPENBLOG_SOCIAL_ENABLED", "true"),
    ("SUPABASE_URL", "https://project.supabase.co"),
    (
        "SUPABASE_SECRET_KEY",
        "sb_secret_socialoptin0000000000000000000000",
    ),
    ("OPENBLOG_SITE_ID", "lantern-studios"),
    (
        "OPENBLOG_SOCIAL_ADMIN_KEY",
        "adm_socialoptin111111111111111111111111111",
    ),
    (
        "OPENBLOG_SOCIAL_WORKER_KEY",
        "wrk_socialoptin222222222222222222222222222",
    ),
    (
        "OPENBLOG_SOCIAL_TOKEN_KEYS",
        "k1:c29jaWFsb3B0aW4zMzMzMzMzMzMzMzMzMzMzMzMzMzM=",
    ),
];

fn project() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "openblog-social-opt-in-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("content/posts")).unwrap();
    fs::write(
        root.join("openblog.json"),
        r#"{"title":"Lantern","url":"https://blog.example.org","syndication":{"targets":{"dev":{"provider":"dev","enabled":true,"allowPublish":false}}}}"#,
    )
    .unwrap();
    fs::write(
        root.join("content/posts/2026-01-02-hello.md"),
        "---\ntitle: Hello\ndate: 2026-01-02\nsyndicationId: hello-2026\ntags: [notes]\n---\n\nA first post with a [link](https://example.org).\n",
    )
    .unwrap();
    root
}

fn run(root: &Path, args: &[&str], social: bool) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_openblog"));
    command.args(args).arg("--root").arg(root);
    command.env_remove("OPENBLOG_WORKSPACE");
    for (name, value) in SECRETS {
        if social {
            command.env(name, value);
        } else {
            command.env_remove(name);
        }
    }
    command.output().unwrap()
}

fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(base, &path, out);
            } else {
                let name = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(name, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(dir, dir, &mut out);
    out
}

fn assert_no_secret(label: &str, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    for (name, value) in SECRETS.iter().skip(1) {
        if value.len() > 20 {
            assert!(!text.contains(value), "{label} contains {name}");
        }
    }
}

#[test]
fn builds_exports_and_cross_posting_plans_ignore_social_publishing_settings() {
    let root = project();
    let plain = root.join("out-plain");
    let social = root.join("out-social");
    let built = run(&root, &["build", "--out", plain.to_str().unwrap()], false);
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let built_social = run(&root, &["build", "--out", social.to_str().unwrap()], true);
    assert!(built_social.status.success());
    let (plain_tree, social_tree) = (tree(&plain), tree(&social));
    assert!(!plain_tree.is_empty());
    assert_eq!(
        plain_tree.keys().collect::<Vec<_>>(),
        social_tree.keys().collect::<Vec<_>>()
    );
    for (name, bytes) in &plain_tree {
        assert!(social_tree[name] == *bytes, "{name} differs");
        assert_no_secret(name, &social_tree[name]);
    }

    for args in [
        &["export", "hello", "--json"][..],
        &["export", "hello", "--format", "markdown"][..],
        &["syndicate", "hello", "--json"][..],
    ] {
        let without = run(&root, args, false);
        let with = run(&root, args, true);
        assert_eq!(without.status.code(), with.status.code(), "{args:?}");
        assert!(without.stdout == with.stdout, "{args:?} stdout differs");
        assert!(without.stderr == with.stderr, "{args:?} stderr differs");
        assert_no_secret(&format!("{args:?}"), &with.stdout);
        assert_no_secret(&format!("{args:?}"), &with.stderr);
    }
    let _ = fs::remove_dir_all(&root);
}
