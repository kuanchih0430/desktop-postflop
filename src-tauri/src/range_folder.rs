use postflop_solver::Range;
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    path: Vec<String>,
    is_group: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

fn read_directory(
    directory: &Path,
    relative: &[String],
    entries: &mut Vec<FolderEntry>,
) -> Result<(), String> {
    entries.push(FolderEntry {
        path: relative.to_vec(),
        is_group: true,
        value: None,
    });
    let mut children = fs::read_dir(directory)
        .map_err(|e| format!("Could not read {}: {e}", relative.join("/")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Could not list {}: {e}", relative.join("/")))?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let name = child
            .file_name()
            .into_string()
            .map_err(|_| format!("A filename in {} is not valid Unicode", relative.join("/")))?;
        if name.starts_with('.') {
            continue;
        }
        let kind = child
            .file_type()
            .map_err(|e| format!("Could not inspect {name}: {e}"))?;
        // Do not follow directory links into cycles or unrelated folders.
        if kind.is_symlink() {
            continue;
        }
        let mut path = relative.to_vec();
        path.push(name);
        if kind.is_dir() {
            read_directory(&child.path(), &path, entries)?;
        } else if kind.is_file()
            && child
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .map_or(false, |extension| extension.eq_ignore_ascii_case("txt"))
        {
            let text = fs::read_to_string(child.path())
                .map_err(|e| format!("Could not read {}: {e}", path.join("/")))?;
            // Support comma-separated ranges across lines, including a UTF-8 BOM.
            let text = text
                .trim_start_matches('\u{feff}')
                .lines()
                .map(|line| line.trim().trim_end_matches(',').trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join(",");
            let range = text
                .parse::<Range>()
                .map_err(|e| format!("{}: {e}", path.join("/")))?;
            entries.push(FolderEntry {
                path,
                is_group: false,
                value: Some(range.to_string()),
            });
        }
    }
    Ok(())
}

fn read_folder(path: &Path) -> Result<Vec<FolderEntry>, String> {
    if !path.is_dir() {
        return Err("Choose a folder containing .txt ranges".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or("The selected folder must have a name")?;
    let mut entries = Vec::new();
    read_directory(path, &[name.to_string()], &mut entries)?;
    Ok(entries)
}

// Disk traversal and validation do not hold or mutate RangeManager's state.
#[tauri::command]
pub async fn range_import_folder(path: String) -> Result<Vec<FolderEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || read_folder(Path::new(&path)))
        .await
        .map_err(|e| format!("Could not import range folder: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempFolder(std::path::PathBuf);
    impl TempFolder {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let folder = Self(std::env::temp_dir().join(format!("range-folder-{nonce}")));
            fs::create_dir(&folder.0).unwrap();
            folder
        }
    }
    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imports_deep_ranges_empty_groups_and_exact_combo_weights() {
        let folder = TempFolder::new();
        let mut deep = folder.0.clone();
        for name in [
            "LJ2bets",
            "HJfolds",
            "COfolds",
            "Bcalls",
            "SB3bets",
            "BBfolds",
            "LJ4bets",
            "Bcalls",
            "SB5bets",
            "LJcalls",
            "空群組",
        ] {
            deep = deep.join(name);
            fs::create_dir(&deep).unwrap();
        }
        fs::write(
            folder.0.join("LJ_raise.txt"),
            "\u{feff}AA:0.25,\nAsKh:0.125,\nAKs\n",
        )
        .unwrap();
        fs::write(deep.parent().unwrap().join("LJ_raise.TXT"), "QQ:0.75").unwrap();
        fs::write(folder.0.join("ignored.json"), "not a range").unwrap();
        fs::write(folder.0.join(".hidden.txt"), "not a range").unwrap();
        let entries = read_folder(&folder.0).unwrap();
        assert_eq!(entries.iter().filter(|entry| !entry.is_group).count(), 2);
        assert!(entries
            .iter()
            .any(|entry| entry.is_group && entry.path.last().unwrap() == "空群組"));
        assert!(entries.iter().any(|entry| entry.path.len() > 10));
        let imported = entries
            .iter()
            .find(|entry| entry.path.last().unwrap() == "LJ_raise.txt")
            .unwrap();
        let actual: Range = imported.value.as_ref().unwrap().parse().unwrap();
        let expected: Range = "AA:0.25,AsKh:0.125,AKs".parse().unwrap();
        assert_eq!(actual.raw_data(), expected.raw_data());
    }

    #[test]
    fn bad_range_reports_its_path_instead_of_importing_partial_results() {
        let folder = TempFolder::new();
        fs::write(folder.0.join("good.txt"), "AA").unwrap();
        fs::create_dir(folder.0.join("HJfolds")).unwrap();
        fs::write(folder.0.join("HJfolds/bad.txt"), "AKs:1.5").unwrap();
        let error = read_folder(&folder.0).unwrap_err();
        assert!(error.contains("HJfolds/bad.txt"));
        assert!(read_folder(&folder.0.join("good.txt")).is_err());
    }

    #[test]
    fn imports_the_supplied_pio_range_without_changing_any_weight() {
        let source = include_str!("../../tests/fixtures/pio-range.txt");
        let folder = TempFolder::new();
        fs::write(folder.0.join("LJ_raise.txt"), source).unwrap();
        let entries = read_folder(&folder.0).unwrap();
        let actual: Range = entries[1].value.as_ref().unwrap().parse().unwrap();
        let expected: Range = source.parse().unwrap();
        assert_eq!(actual.raw_data(), expected.raw_data());
        assert_eq!(actual.get_weight_pair(12), 1.0); // AA
        assert_eq!(actual.get_weight_pair(7), 0.75); // 99
        assert_eq!(actual.get_weight_pair(5), 0.5); // 77
        assert_eq!(actual.get_weight_pair(4), 0.25); // 66
        assert_eq!(actual.get_weight_suited(12, 11), 1.0); // AK includes both forms
        assert_eq!(actual.get_weight_offsuit(12, 11), 1.0);
        assert_eq!(actual.get_weight_offsuit(12, 10), 0.75); // AQo
        assert_eq!(actual.get_weight_offsuit(12, 9), 0.5); // AJo
        assert_eq!(actual.get_weight_suited(2, 1), 0.5); // 43s
        assert_eq!(actual.get_weight_pair(0), 0.0); // 22 omitted
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlink_cycles() {
        let folder = TempFolder::new();
        std::os::unix::fs::symlink(&folder.0, folder.0.join("loop")).unwrap();
        fs::write(folder.0.join("range.txt"), "AA").unwrap();
        assert_eq!(read_folder(&folder.0).unwrap().len(), 2);
    }
}
