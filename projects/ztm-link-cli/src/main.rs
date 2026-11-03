mod picker;

use std::error::Error;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crossterm::cursor::MoveTo;
use crossterm::execute;
use crossterm::style::Stylize;
use crossterm::terminal::{Clear, ClearType};

use picker::{Outcome, Picker};

const APP_NAME: &str = env!("CARGO_PKG_NAME");
const REPO_RAW_URL: &str =
    "https://raw.githubusercontent.com/ztm-desktop-application/zero-to-mastery-links/main";
const CSV_FILES: [&str; 2] = ["course.csv", "path.csv"];

/// A single row from one of the CSV files.
struct Link {
    name: String,
    url: String,
}

/// The per-user cache directory for downloaded CSV files, e.g.
/// `~/.cache/ztm-link-cli` on Linux, `~/Library/Caches/ztm-link-cli` on macOS
/// and `%LOCALAPPDATA%\ztm-link-cli` on Windows. Falls back to the system temp
/// directory if the platform has no cache directory.
fn data_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_NAME)
}

/// Download the CSV files from the zero-to-mastery-links repo into `dir`.
fn download_data(dir: &Path) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(dir)?;

    for file in CSV_FILES {
        let url = format!("{REPO_RAW_URL}/{file}");
        let body = ureq::get(&url).call()?.body_mut().read_to_string()?;
        fs::write(dir.join(file), body)?;
    }

    Ok(())
}

/// Read a CSV file with a header row and two columns: name, url.
fn load_links(dir: &Path, file: &str) -> Result<Vec<Link>, Box<dyn Error>> {
    let mut reader = csv::Reader::from_path(dir.join(file))?;
    let mut links = Vec::new();

    for record in reader.records() {
        let record = record?;
        links.push(Link {
            name: record[0].to_string(),
            url: record[1].to_string(),
        });
    }

    Ok(links)
}

/// Clear the terminal and move the cursor to the top-left corner.
fn clear_screen() -> io::Result<()> {
    execute!(io::stdout(), Clear(ClearType::All), MoveTo(0, 0))
}

/// Clear the terminal and print the app title with the number of links loaded.
fn print_header(courses: usize, paths: usize) -> io::Result<()> {
    clear_screen()?;
    println!("{}", "Zero To Mastery Links".cyan().bold());
    println!(
        "{}\n",
        format!("{courses} courses · {paths} career paths").dim()
    );
    Ok(())
}

/// Show every link and filter the list as the user types.
fn select_link(title: &str, links: &[Link]) -> io::Result<Outcome> {
    let names = links.iter().map(|link| link.name.as_str()).collect();
    Picker::new(title, names)
        .help("type to filter, ↑↓ to move, Enter to open, Esc to go back")
        .filterable()
        .run()
}

fn run() -> Result<(), Box<dyn Error>> {
    clear_screen()?;
    print!("{}", "Fetching latest links…".dim());
    io::stdout().flush()?;

    let dir = data_dir();
    download_data(&dir)?;
    let courses = load_links(&dir, "course.csv")?;
    let paths = load_links(&dir, "path.csv")?;

    loop {
        print_header(courses.len(), paths.len())?;

        let choice = Picker::new(
            "What would you like to browse?",
            vec!["Courses", "Career Paths", "Quit"],
        )
        .help("↑↓ to move, Enter to select, Esc to quit")
        .gap_after(1)
        .run()?;

        let (title, links) = match choice {
            Outcome::Selected(0) => ("Courses:", &courses),
            Outcome::Selected(1) => ("Career Paths:", &paths),
            _ => return Ok(clear_screen()?),
        };

        print_header(courses.len(), paths.len())?;

        match select_link(title, links)? {
            Outcome::Selected(index) => {
                let link = &links[index];
                println!(
                    "{} {}",
                    "Opening".green().bold(),
                    link.url.as_str().underlined()
                );
                open::that(&link.url)?;
                return Ok(());
            }
            Outcome::Back => continue,
            Outcome::Quit => return Ok(clear_screen()?),
        }
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{} {e}", "Error:".red().bold());
        std::process::exit(1);
    }
}
