// src-tauri/src/template_manager.rs
//
// Equivalent to electron/templateManager.ts
// Manages filter templates stored as TOML files (.vkfilter)

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterTemplate {
    pub name: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<toml::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<toml::Value>,
}

pub struct TemplateManager;

impl TemplateManager {
    pub fn new() -> Self {
        TemplateManager
    }

    fn templates_dir(&self) -> std::path::PathBuf {
        crate::paths::filter_templates()
    }

    /// Sanitize a template name for use as a filename
    fn sanitize_name(name: &str) -> String {
        name.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '_' || c == '-' || c == ' ' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }

    fn template_path(&self, name: &str) -> std::path::PathBuf {
        self.templates_dir()
            .join(format!("{}.vkfilter", Self::sanitize_name(name)))
    }

    async fn ensure_templates_dir(&self) -> Result<()> {
        fs::create_dir_all(self.templates_dir()).await?;
        Ok(())
    }

    /// Load all templates from the templates directory
    pub async fn load_templates(&self) -> Result<Vec<FilterTemplate>> {
        self.ensure_templates_dir().await?;

        let dir = self.templates_dir();
        let mut entries = fs::read_dir(&dir).await?;
        let mut templates = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("vkfilter") {
                continue;
            }

            match fs::read_to_string(&path).await {
                Ok(content) => match toml::from_str::<FilterTemplate>(&content) {
                    Ok(t) => {
                        templates.push(t);
                    }
                    Err(e) => {
                        log::warn!("Invalid template {:?}: {}", path.file_name(), e);
                    }
                },
                Err(e) => {
                    log::error!("Error reading template {:?}: {}", path.file_name(), e);
                }
            }
        }

        log::info!("Loaded {} filter template(s)", templates.len());
        Ok(templates)
    }

    /// Save a template to disk
    pub async fn save_template(&self, mut template: FilterTemplate) -> Result<()> {
        self.ensure_templates_dir().await?;

        // Ensure metadata has a createdAt timestamp
        if template.metadata.is_none() {
            let mut map = toml::map::Map::new();
            map.insert(
                "createdAt".to_string(),
                toml::Value::String(chrono::Utc::now().to_rfc3339()),
            );
            template.metadata = Some(toml::Value::Table(map));
        }

        let content = toml::to_string(&template).context("serialize template")?;
        let path = self.template_path(&template.name);
        fs::write(&path, content).await?;
        log::info!("Saved template: {}", template.name);
        Ok(())
    }

    /// Delete a template by name
    pub async fn delete_template(&self, name: &str) -> Result<()> {
        let path = self.template_path(name);
        if path.exists() {
            fs::remove_file(&path).await?;
            log::info!("Deleted template: {}", name);
        } else {
            bail!("Template not found: {}", name);
        }
        Ok(())
    }

    /// Parse a TOML template file from raw content
    pub fn parse_template(content: &str) -> Result<FilterTemplate> {
        let template: FilterTemplate = toml::from_str(content).context("parse template TOML")?;
        if template.name.is_empty() {
            bail!("Invalid template: missing 'name' field");
        }
        Ok(template)
    }

    /// Create built-in default templates if they don't exist yet.
    pub async fn create_default_templates(&mut self) -> Result<()> {
        self.ensure_templates_dir().await?;

        // Copy any bundled .vkfilter files from the include/filter_templates directory
        // (they may have been placed there during installation)
        let include_templates =
            crate::paths::app_data().join("..").join("include").join("filter_templates");
        if include_templates.exists() {
            let mut entries = fs::read_dir(&include_templates).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("vkfilter") {
                    let dest = self.templates_dir().join(
                        path.file_name().expect("file name"),
                    );
                    if !dest.exists() {
                        let _ = fs::copy(&path, &dest).await;
                    }
                }
            }
        }

        Ok(())
    }
}
