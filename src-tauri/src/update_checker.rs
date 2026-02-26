// src-tauri/src/update_checker.rs
//
// Equivalent to electron/updateChecker.ts

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

const GITHUB_OWNER: &str = "Kim2091";
const GITHUB_REPO: &str = "vapourkit";

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: String,
    body: String,
    html_url: String,
    published_at: String,
    prerelease: bool,
    draft: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_url: String,
    pub changelog: String,
    pub published_at: String,
}

pub fn get_releases_page_url() -> String {
    format!("https://github.com/{}/{}/releases", GITHUB_OWNER, GITHUB_REPO)
}

pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Compare two semver strings. Returns true if latest > current.
fn is_newer(current: &str, latest: &str) -> bool {
    compare_versions(latest, current) > 0
}

fn compare_versions(v1: &str, v2: &str) -> i32 {
    let clean1 = v1.trim_start_matches('v');
    let clean2 = v2.trim_start_matches('v');

    let parts1: Vec<u64> = clean1
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    let parts2: Vec<u64> = clean2
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();

    let len = parts1.len().max(parts2.len());
    for i in 0..len {
        let a = parts1.get(i).copied().unwrap_or(0);
        let b = parts2.get(i).copied().unwrap_or(0);
        if a > b {
            return 1;
        }
        if a < b {
            return -1;
        }
    }
    0
}

pub async fn check_for_updates() -> Result<UpdateInfo> {
    let current_version = get_app_version();
    log::info!("Checking for updates, current version: {}", current_version);

    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        GITHUB_OWNER, GITHUB_REPO
    );

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("vapourkit-app")
        .build()?;

    let release: GitHubRelease = client
        .get(&url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .context("GitHub API request")?
        .json()
        .await
        .context("parse GitHub response")?;

    if release.draft || release.prerelease {
        log::info!("Latest release is draft/prerelease, skipping");
        return Ok(UpdateInfo {
            available: false,
            current_version: current_version.clone(),
            latest_version: current_version,
            release_url: String::new(),
            changelog: String::new(),
            published_at: String::new(),
        });
    }

    let latest = release.tag_name.trim_start_matches('v').to_string();
    let available = is_newer(&current_version, &latest);

    log::info!(
        "Latest version: {}, available: {}",
        latest,
        available
    );

    Ok(UpdateInfo {
        available,
        current_version,
        latest_version: latest,
        release_url: release.html_url,
        changelog: release.body,
        published_at: release.published_at,
    })
}
