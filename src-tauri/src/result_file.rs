use crate::range::{range_weights, RangeManager};
use crate::tree::encode_line;
use postflop_solver::*;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{System, SystemExt};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSettings {
    num_threads: u32,
    target_exploitability: f64,
    max_iterations: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SolverSetup {
    config: serde_json::Value,
    ranges: [Vec<f32>; 2],
    range_texts: [String; 2],
    compression_enabled: bool,
}

fn bet_text(sizes: &[BetSize]) -> String {
    sizes
        .iter()
        .map(|size| match *size {
            BetSize::PotRelative(value) => format!("{}", value * 100.0),
            BetSize::PrevBetRelative(value) => format!("{value}x"),
            BetSize::Additive(value, 0) => format!("{value}c"),
            BetSize::Additive(value, cap) => format!("{value}c{cap}r"),
            BetSize::Geometric(streets, maximum) => {
                let streets = if streets == 0 {
                    String::new()
                } else {
                    streets.to_string()
                };
                let maximum = if maximum.is_infinite() {
                    String::new()
                } else {
                    (maximum * 100.0).to_string()
                };
                format!("{streets}e{maximum}")
            }
            BetSize::AllIn => "a".into(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

impl SolverSetup {
    fn from_game(game: &PostFlopGame, board: &[u8]) -> Self {
        let cards = game.card_config();
        let tree = game.tree_config();
        let added = game
            .added_lines()
            .iter()
            .map(|line| encode_line(line))
            .collect::<Vec<_>>()
            .join(",");
        let removed = game
            .removed_lines()
            .iter()
            .map(|line| encode_line(line))
            .collect::<Vec<_>>()
            .join(",");
        let edited = !added.is_empty() || !removed.is_empty();
        Self {
            config: serde_json::json!({
                "board": board,
                "startingPot": tree.starting_pot,
                "effectiveStack": tree.effective_stack,
                "rakePercent": tree.rake_rate * 100.0,
                "rakeCap": tree.rake_cap,
                "donkOption": tree.turn_donk_sizes.is_some() || tree.river_donk_sizes.is_some(),
                "oopFlopBet": bet_text(&tree.flop_bet_sizes[0].bet),
                "oopFlopRaise": bet_text(&tree.flop_bet_sizes[0].raise),
                "ipFlopBet": bet_text(&tree.flop_bet_sizes[1].bet),
                "ipFlopRaise": bet_text(&tree.flop_bet_sizes[1].raise),
                "oopTurnBet": bet_text(&tree.turn_bet_sizes[0].bet),
                "oopTurnRaise": bet_text(&tree.turn_bet_sizes[0].raise),
                "ipTurnBet": bet_text(&tree.turn_bet_sizes[1].bet),
                "ipTurnRaise": bet_text(&tree.turn_bet_sizes[1].raise),
                "oopRiverBet": bet_text(&tree.river_bet_sizes[0].bet),
                "oopRiverRaise": bet_text(&tree.river_bet_sizes[0].raise),
                "ipRiverBet": bet_text(&tree.river_bet_sizes[1].bet),
                "ipRiverRaise": bet_text(&tree.river_bet_sizes[1].raise),
                "oopTurnDonk": tree.turn_donk_sizes.as_ref().map(|s| bet_text(&s.donk)).unwrap_or_default(),
                "oopRiverDonk": tree.river_donk_sizes.as_ref().map(|s| bet_text(&s.donk)).unwrap_or_default(),
                "addAllInThreshold": tree.add_allin_threshold * 100.0,
                "forceAllInThreshold": tree.force_allin_threshold * 100.0,
                "mergingThreshold": tree.merging_threshold * 100.0,
                "expectedBoardLength": if edited { board.len() } else { 0 },
                "addedLines": added,
                "removedLines": removed,
            }),
            ranges: std::array::from_fn(|player| {
                range_weights(&cards.range[player])
                    .iter()
                    .map(|w| w * 100.0)
                    .collect()
            }),
            range_texts: std::array::from_fn(|player| cards.range[player].to_string()),
            compression_enabled: game.is_compression_enabled(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunStats {
    iterations: u32,
    exploitability: f32,
    elapsed_time_ms: f64,
    stopped_early: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    run_settings: Option<RunSettings>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultMetadata {
    format_version: u32,
    board: Vec<u8>,
    starting_pot: i32,
    effective_stack: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    solver_setup: Option<SolverSetup>,
    #[serde(flatten)]
    stats: RunStats,
}

impl ResultMetadata {
    fn from_game(game: &PostFlopGame, stats: RunStats) -> Self {
        let cards = game.card_config();
        let tree = game.tree_config();
        let mut board = cards.flop.to_vec();
        if cards.turn != NOT_DEALT {
            board.push(cards.turn);
        }
        if cards.river != NOT_DEALT {
            board.push(cards.river);
        }
        let solver_setup = Some(SolverSetup::from_game(game, &board));
        Self {
            format_version: 1,
            board,
            starting_pot: tree.starting_pot,
            effective_stack: tree.effective_stack,
            solver_setup,
            stats,
        }
    }

    fn validate(&self, game: &PostFlopGame) -> Result<(), String> {
        if self.format_version != 1 {
            return Err("Unsupported saved-result format version".into());
        }
        if !self.stats.exploitability.is_finite()
            || self.stats.exploitability < 0.0
            || !self.stats.elapsed_time_ms.is_finite()
            || self.stats.elapsed_time_ms < 0.0
        {
            return Err("Invalid solve statistics in saved result".into());
        }
        if let Some(settings) = &self.stats.run_settings {
            if !(1..=64).contains(&settings.num_threads)
                || !settings.target_exploitability.is_finite()
                || settings.target_exploitability <= 0.0
                || settings.max_iterations > 100000
            {
                return Err("Invalid solver run settings".into());
            }
        }
        let expected = Self::from_game(game, self.stats.clone());
        if self.board != expected.board
            || self.starting_pot != expected.starting_pot
            || self.effective_stack != expected.effective_stack
        {
            return Err("Saved-result metadata does not match the game tree".into());
        }
        Ok(())
    }
}

fn validate_game(game: &PostFlopGame) -> Result<(), String> {
    if !game.is_solved() {
        return Err("Only finalized results can be saved or opened".into());
    }
    if game.storage_mode() != BoardState::River {
        return Err("This version requires the complete tree through the river".into());
    }
    // memory_usage_bunching() estimates potential usage even when Bunching is off.
    // Bunching instead changes the engine's number of possible chance outcomes.
    let ordinary_chance_factor = if game.card_config().turn == NOT_DEALT {
        45
    } else {
        44
    };
    if game.chance_factor(&game.root()) != ordinary_chance_factor {
        return Err("Saving results with Bunching is not supported yet".into());
    }
    Ok(())
}

fn write_result(
    path: &Path,
    game: &mut PostFlopGame,
    stats: RunStats,
) -> Result<ResultMetadata, String> {
    validate_game(game)?;
    let metadata = ResultMetadata::from_game(game, stats);
    metadata.validate(game)?;
    // Setup is already stored losslessly in the game. Reconstruct it for the UI
    // rather than duplicating ranges and tree settings in the uncompressed memo.
    let mut file_metadata = metadata.clone();
    file_metadata.solver_setup = None;
    let memo = serde_json::to_string(&file_metadata).map_err(|e| e.to_string())?;
    game.set_target_storage_mode(BoardState::River)?;

    // Write beside the destination, then rename: failed writes leave the old file intact.
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(".postflop-{}-{}.tmp", std::process::id(), nonce));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| format!("Could not create result file: {e}"))?;
    let result = (|| {
        let mut writer = BufWriter::new(file);
        // Lossless file compression, independent of the solver's 16/32-bit precision.
        save_data_into_std_write(game, &memo, &mut writer, Some(3))?;
        writer.flush().map_err(|e| e.to_string())?;
        writer.get_ref().sync_all().map_err(|e| e.to_string())?;
        drop(writer);
        fs::rename(&temporary, path).map_err(|e| format!("Could not replace result file: {e}"))?;
        Ok(metadata)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_result(
    path: &Path,
    max_memory: Option<u64>,
) -> Result<(PostFlopGame, ResultMetadata), String> {
    let (mut game, memo): (PostFlopGame, String) =
        load_data_from_file(path, max_memory).map_err(|error| {
            if error == "Estimated memory usage is too large" {
                match max_memory {
                    Some(limit) => format!(
                        "The saved tree exceeds the current load budget of {:.2} GiB. \
                         The existing tree is kept in memory until loading succeeds. \
                         Save your current result and restart the app to free that memory before retrying.",
                        limit as f64 / (1024.0 * 1024.0 * 1024.0)
                    ),
                    None => error,
                }
            } else {
                error
            }
        })?;
    validate_game(&game)?;
    let mut metadata: ResultMetadata = serde_json::from_str(&memo)
        .map_err(|e| format!("Not a supported Desktop Postflop result file: {e}"))?;
    metadata.validate(&game)?;
    metadata.solver_setup = Some(SolverSetup::from_game(&game, &metadata.board));
    game.back_to_root();
    Ok((game, metadata))
}

fn replace_result(
    current: &Mutex<PostFlopGame>,
    ranges: &Mutex<RangeManager>,
    path: &Path,
    max_memory: Option<u64>,
) -> Result<ResultMetadata, String> {
    let (game, metadata) = read_result(path, max_memory)?;
    // Match game_init's lock order and acquire both locks before changing either.
    let mut ranges = ranges.lock().map_err(|e| e.to_string())?;
    let mut current = current.lock().map_err(|e| e.to_string())?;
    ranges.0[..2].clone_from_slice(&game.card_config().range);
    *current = game;
    Ok(metadata)
}

#[tauri::command(async)]
pub fn game_save_result(
    game_state: tauri::State<Mutex<PostFlopGame>>,
    path: String,
    stats: RunStats,
) -> Result<ResultMetadata, String> {
    let mut game = game_state.lock().map_err(|e| e.to_string())?;
    write_result(Path::new(&path), &mut game, stats)
}

fn load_memory_budget(is_macos: bool, total: u64, available: u64, retained_tree: u64) -> u64 {
    if is_macos {
        // Match RunSolver's policy: macOS available memory is not a reliable limit.
        // Unlike a new solve, loading must keep the previous tree alive as well.
        (total.saturating_mul(7) / 10).saturating_sub(retained_tree)
    } else {
        // Other platforms' available memory already excludes the retained tree.
        available
    }
}

fn retained_tree_memory(game: &PostFlopGame) -> u64 {
    if !game.is_solved() && !game.is_ready() {
        return 0;
    }
    let (raw, compressed) = game.memory_usage();
    if game.is_compression_enabled() {
        compressed
    } else {
        raw
    }
}

#[tauri::command(async)]
pub fn game_load_result(
    game_state: tauri::State<Mutex<PostFlopGame>>,
    range_state: tauri::State<Mutex<RangeManager>>,
    path: String,
) -> Result<ResultMetadata, String> {
    let system = System::new_all();
    let retained_memory = {
        let current = game_state.lock().map_err(|e| e.to_string())?;
        retained_tree_memory(&current)
    };
    let budget = load_memory_budget(
        cfg!(target_os = "macos"),
        system.total_memory(),
        system.available_memory(),
        retained_memory,
    );
    // Keep the old result alive until decoding and all validation have succeeded.
    replace_result(&game_state, &range_state, Path::new(&path), Some(budget))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_load_budget_uses_total_memory_and_reserves_the_previous_tree() {
        assert_eq!(load_memory_budget(true, 1000, 10, 100), 600);
        assert_eq!(load_memory_budget(true, 1000, 10, 0), 700);
        assert_eq!(load_memory_budget(true, 1000, 10, 800), 0);
        assert_eq!(load_memory_budget(false, 1000, 500, 100), 500);
        assert_eq!(retained_tree_memory(&PostFlopGame::default()), 0);
    }

    struct TestDirectory(std::path::PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_game(state: BoardState, compressed: bool) -> PostFlopGame {
        let cards = CardConfig {
            range: ["AsAh".parse().unwrap(), "KsKh".parse().unwrap()],
            flop: flop_from_str("2c3d7h").unwrap(),
            turn: if state >= BoardState::Turn {
                card_from_str("9s").unwrap()
            } else {
                NOT_DEALT
            },
            river: if state == BoardState::River {
                card_from_str("Jc").unwrap()
            } else {
                NOT_DEALT
            },
        };
        let bets = BetSizeOptions::try_from(("50%", "")).unwrap();
        let tree = ActionTree::new(TreeConfig {
            initial_state: state,
            starting_pot: 20,
            effective_stack: 100,
            river_bet_sizes: [bets.clone(), bets],
            ..Default::default()
        })
        .unwrap();
        let mut game = PostFlopGame::with_config(cards, tree).unwrap();
        game.allocate_memory(compressed);
        solve_step(&game, 0);
        solve_step(&game, 1);
        finalize(&mut game);
        game
    }

    fn snapshot(game: &mut PostFlopGame) -> (Vec<Action>, Vec<f32>, Vec<f32>, Vec<f32>) {
        game.cache_normalized_weights();
        (
            game.available_actions(),
            game.strategy(),
            game.expected_values(0),
            game.equity(0),
        )
    }

    fn walk_to_river(game: &mut PostFlopGame) {
        while game.current_board().len() < 5 {
            if game.is_chance_node() {
                game.play(game.possible_cards().trailing_zeros() as usize);
            } else {
                game.play(0);
            }
        }
    }

    // Keep solving in one test: custom-alloc supports a single solving game at a time.
    #[test]
    fn result_roundtrip_and_failure_preservation() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            TestDirectory(std::env::temp_dir().join(format!("postflop-result-test-{nonce}")));
        fs::create_dir(&directory.0).unwrap();
        let path = directory.0.join("result.dpfresult");
        let stats = RunStats {
            iterations: 2,
            exploitability: 0.25,
            elapsed_time_ms: 125.0,
            stopped_early: true,
            run_settings: Some(RunSettings {
                num_threads: 2,
                target_exploitability: 0.3,
                max_iterations: 1000,
            }),
        };

        for state in [BoardState::Flop, BoardState::Turn, BoardState::River] {
            for compressed in [false, true] {
                let mut game = sample_game(state, compressed);
                let root = snapshot(&mut game);
                walk_to_river(&mut game);
                let river = snapshot(&mut game);
                let history = game.history().to_vec();
                let metadata = write_result(&path, &mut game, stats.clone()).unwrap();
                assert_eq!(game.history(), history); // Saving must not move the viewer.
                let (mut loaded, restored) = read_result(&path, None).unwrap();
                assert_eq!(metadata, restored);
                assert_eq!(snapshot(&mut loaded), root);
                walk_to_river(&mut loaded);
                assert_eq!(snapshot(&mut loaded), river);

                // Existing uncompressed files must still open without conversion.
                let legacy_path = directory.0.join("legacy.dpfresult");
                let mut legacy_memo = metadata.clone();
                legacy_memo.solver_setup = None;
                legacy_memo.stats.run_settings = None;
                save_data_to_file(
                    &game,
                    &serde_json::to_string(&legacy_memo).unwrap(),
                    &legacy_path,
                    None,
                )
                .unwrap();
                let (mut legacy, legacy_metadata) = read_result(&legacy_path, None).unwrap();
                assert_eq!(legacy_metadata.solver_setup, metadata.solver_setup);
                assert_eq!(legacy_metadata.stats.run_settings, None);
                assert_eq!(snapshot(&mut legacy), root);
                walk_to_river(&mut legacy);
                assert_eq!(snapshot(&mut legacy), river);
                if state == BoardState::Flop && !compressed {
                    let raw_size = fs::metadata(&legacy_path).unwrap().len();
                    let packed_size = fs::metadata(&path).unwrap().len();
                    assert!(packed_size < raw_size);
                    println!("Sample flop tree: {raw_size} bytes uncompressed -> {packed_size} bytes zstd");
                }
            }
        }

        let (game, _) = read_result(&path, None).unwrap();
        // Recover non-default editor settings, including manually edited branches.
        let mut tree_config = game.tree_config().clone();
        tree_config.rake_rate = 0.05;
        tree_config.rake_cap = 2.0;
        tree_config.flop_bet_sizes[0] = ("50%, 100c, 2e200%, e, a", "2.5x, 20c3r")
            .try_into()
            .unwrap();
        tree_config.turn_donk_sizes = Some("25%".try_into().unwrap());
        tree_config.river_donk_sizes = Some("75%".try_into().unwrap());
        let mut edited_tree = ActionTree::new(tree_config).unwrap();
        edited_tree.remove_line(&[Action::Bet(10)]).unwrap();
        edited_tree.add_line(&[Action::Bet(15)]).unwrap();
        let editor_game =
            PostFlopGame::with_config(game.card_config().clone(), edited_tree).unwrap();
        let editor_setup = SolverSetup::from_game(&editor_game, &game.current_board());
        assert_eq!(editor_setup.config["rakePercent"], 5.0);
        assert_eq!(editor_setup.config["rakeCap"], 2.0);
        assert_eq!(editor_setup.config["donkOption"], true);
        assert_eq!(editor_setup.config["oopTurnDonk"], "25");
        assert_eq!(editor_setup.config["oopRiverDonk"], "75");
        assert_eq!(editor_setup.config["addedLines"], "B15");
        assert_eq!(editor_setup.config["removedLines"], "B10");
        assert_eq!(editor_setup.config["expectedBoardLength"], 5);
        assert!(editor_setup.config["oopFlopBet"]
            .as_str()
            .unwrap()
            .contains("2e200"));
        assert!(editor_setup.config["oopFlopRaise"]
            .as_str()
            .unwrap()
            .contains("20c3r"));
        let current = Mutex::new(game);
        let ranges = Mutex::new(RangeManager::default());
        let before = snapshot(&mut current.lock().unwrap());
        let corrupt = directory.0.join("corrupt.dpfresult");
        fs::write(&corrupt, b"not a result").unwrap();
        assert!(replace_result(&current, &ranges, &corrupt, None).is_err());
        assert_eq!(snapshot(&mut current.lock().unwrap()), before);
        let restored = replace_result(&current, &ranges, &path, None).unwrap();
        {
            let current_guard = current.lock().unwrap();
            let ranges_guard = ranges.lock().unwrap();
            for player in 0..2 {
                assert_eq!(
                    ranges_guard.0[player].raw_data(),
                    current_guard.card_config().range[player].raw_data()
                );
                assert_eq!(
                    restored.solver_setup.as_ref().unwrap().ranges[player],
                    range_weights(&ranges_guard.0[player])
                        .iter()
                        .map(|w| w * 100.0)
                        .collect::<Vec<_>>()
                );
            }
        }
        let memory_error = replace_result(&current, &ranges, &path, Some(0)).unwrap_err();
        assert!(memory_error.contains("load budget of 0.00 GiB"));
        assert!(memory_error.contains("restart the app"));
        assert_eq!(snapshot(&mut current.lock().unwrap()), before);

        let bytes = fs::read(&path).unwrap();
        fs::write(&corrupt, &bytes[..bytes.len() / 2]).unwrap();
        assert!(replace_result(&current, &ranges, &corrupt, None).is_err());
        assert_eq!(snapshot(&mut current.lock().unwrap()), before);
        assert!(write_result(&path, &mut PostFlopGame::default(), stats.clone()).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let mut game = current.lock().unwrap();
        let mut invalid_stats = stats.clone();
        invalid_stats.exploitability = f32::NAN;
        assert!(write_result(&path, &mut game, invalid_stats).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(write_result(&directory.0, &mut game, stats).is_err());
        assert!(!fs::read_dir(&directory.0).unwrap().any(|e| e
            .unwrap()
            .path()
            .extension()
            .map_or(false, |ext| ext == "tmp")));

        let mut bad_metadata = ResultMetadata::from_game(
            &game,
            RunStats {
                iterations: 2,
                exploitability: 0.25,
                elapsed_time_ms: 125.0,
                stopped_early: false,
                run_settings: None,
            },
        );
        bad_metadata.format_version = 99;
        save_data_to_file(
            &*game,
            &serde_json::to_string(&bad_metadata).unwrap(),
            &corrupt,
            None,
        )
        .unwrap();
        drop(game);
        assert!(replace_result(&current, &ranges, &corrupt, None).is_err());
        assert_eq!(snapshot(&mut current.lock().unwrap()), before);
    }
}
