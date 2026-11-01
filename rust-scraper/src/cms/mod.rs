use std::{collections::HashMap, io::Write};
use m3u8_rs::MediaPlaylist;
use scraper::{Html, Selector};

pub struct CmsClient {
    client: reqwest::Client,
    email: String,
    password: String,
    root_url: String,
    download_dir: String,
}

pub enum CmsError {
    LoginFailed,
    RequestFailed,
    MediaPlaylistNotFound,
    ReqwestError(reqwest::Error),
    SerdeError(serde_json::Error),
    IOError(std::io::Error),
}
impl std::fmt::Display for CmsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CmsError::LoginFailed => write!(f, "Login failed"),
            CmsError::RequestFailed => write!(f, "Request failed"),
            CmsError::MediaPlaylistNotFound => write!(f, "Media playlist not found"),
            CmsError::ReqwestError(e) => write!(f, "Reqwest error: {}", e),
            CmsError::SerdeError(e) => write!(f, "Serde error: {}", e),
            CmsError::IOError(e) => write!(f, "IO error: {}", e),
        }
    }
}
impl std::error::Error for CmsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CmsError::ReqwestError(e) => Some(e),
            CmsError::SerdeError(e) => Some(e),
            _ => None,
        }
    }
}
impl From<reqwest::Error> for CmsError {
    fn from(err: reqwest::Error) -> CmsError {
        CmsError::ReqwestError(err)
    }
}

impl From<std::io::Error> for CmsError {
    fn from(err: std::io::Error) -> CmsError {
        CmsError::IOError(err)
    }
}

impl From<serde_json::Error> for CmsError {
    fn from(err: serde_json::Error) -> CmsError {
        CmsError::SerdeError(err)
    }
}
impl std::fmt::Debug for CmsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self)
    }
}

impl CmsClient {
    pub fn new(email: String, password: String, root_url: String, download_dir: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .cookie_store(true)
                .build()
                .unwrap(),
            email,
            password,
            root_url,
            download_dir,
        }
    }
    pub async fn login(&self) -> Result<(), CmsError> {
        let login_url = format!("{}/cms/system/login", self.root_url);

        let mut login_data = HashMap::new();
        login_data.insert("action", "processXdget");
        login_data.insert("xdgetId", "99945_1");
        login_data.insert("params[action]", "login");
        login_data.insert("params[url]", &login_url);
        login_data.insert("params[email]", &self.email);
        login_data.insert("params[password]", &self.password);
        login_data.insert("params[null]", "");
        login_data.insert("params[object_type]", "cms_page");
        login_data.insert("params[object_id]", "-1");


        let response = self.client
            .post(&login_url)
            .form(&login_data)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(CmsError::LoginFailed);
        }

        Ok(())
    }

    pub async fn get_links(&self, url: String) -> Result<Vec<String>, CmsError> {
        let response = self.client.get(format!("{}{}", self.root_url, url))
        .send()
        .await?;


        if !response.status().is_success() {
            return Err(CmsError::RequestFailed);
        }

        let mut items = Vec::new();
        let body = response.text().await?;

        let document = Html::parse_document(&body);
        let selector = Selector::parse("ul a").unwrap();

        for element in document.select(&selector) {
            if let Some(href) = element.value().attr("href") {
                items.push(href.to_string());
            }
        }

        Ok(items)
    }

    pub async fn get_playlist_url(&self, link: &str) -> Result<(String, String), CmsError> {
        let response = self.client.get(format!("{}{}", self.root_url, link)).send().await?;

        let mut title = "".to_string();
        let mut url = "".to_string();

        if !response.status().is_success() {
            return Err(CmsError::RequestFailed);
        }

        let body = response.text().await?;

        let document = Html::parse_document(&body);
        let selector = Selector::parse("div[id^=vhi-root-]").unwrap();
        for element in document.select(&selector) {
            if let Some(href) = element.attr("data-iframe-src") {
                url = href.to_string();
                break
            } else {
                println!("Element does not have an href attribute");
            }
        }

        let selector: Selector = Selector::parse("h2").unwrap();
        for element in document.select(&selector) {
            title = element.text().collect::<Vec<_>>().join(" ");
        }


        Ok((title, url))
    }

    pub async fn get_stream_url(&self, url: String) -> Result<Option<String>, CmsError> {
        let response = self.client.get(url).send().await?;

        if !response.status().is_success() {
            return Err(CmsError::RequestFailed);
        }

        let body = response.text().await?;

        let mut playlist_url: String = "".to_string();

        let document = Html::parse_document(&body);
        let selector: Selector = Selector::parse("script").unwrap();
        for element in document.select(&selector) {
            let text = element.text().collect::<Vec<_>>().join(" ");

            if !text.contains("window.configs =") {
                continue
            }

            let text = text.replace("window.configs =", "");
            let text = text.trim();
            let data:serde_json::Value = serde_json::from_str(text).unwrap();

            playlist_url = data.get("masterPlaylistUrl").unwrap().to_string().replace("\"", "");
        }

        let response = self.client.get(playlist_url.as_str()).send().await?;
        if !response.status().is_success() {
            println!("Failed to access the protected page with status: {}", response.status());
        }
        let body = response.text().await?;

        let parsed = m3u8_rs::parse_playlist_res(&body.as_bytes());

        match parsed {
            Ok(m3u8_rs::Playlist::MasterPlaylist(pl)) => {

                for variant in pl.variants {
                    if let Some(res) =  variant.resolution {
                        if res.height == 1080 && res.width == 1920 {
                            return Ok(Some(variant.uri))
                        }
                    }
                }
            },
            Ok(m3u8_rs::Playlist::MediaPlaylist(pl)) => println!("Media playlist:\n{:?}", pl),
            Err(e) => println!("Error: {:?}", e),
        }

        Ok(None)
    }

    pub async fn get_media_playlist(&self, url: String) -> Result<MediaPlaylist, CmsError> {
        let response = self.client.get(url).send().await?;

        if !response.status().is_success() {
            println!("Failed to access the protected page with status: {}", response.status());
        }
        let body = response.text().await?;

        let parsed = m3u8_rs::parse_playlist_res(&body.as_bytes());

        match parsed {
            Ok(m3u8_rs::Playlist::MasterPlaylist(pl)) => {
                println!("Master playlist:\n{:?}", pl);
            },
            Ok(m3u8_rs::Playlist::MediaPlaylist(pl)) => return Ok(pl),
            Err(e) => println!("Error: {:?}", e),
        }
        Err(CmsError::MediaPlaylistNotFound)
    }

    pub async fn download_media(&self, url: String) -> Result<Vec<u8>, CmsError> {
        let response = self.client.get(url).send().await?;

        if !response.status().is_success() {
            println!("Failed to access the protected page with status: {}", response.status());
        }
        let body = response.bytes().await?;

        Ok(body.to_vec())
    }

    pub async fn download_lesson(&self, url: &String, folder: String, index: usize) -> Result<(), CmsError> {
        let (title, url) = self.get_playlist_url(&url).await?;

        match std::fs::create_dir_all(format!("{}/{}", self.download_dir, folder)) {
            Ok(_) => println!("Directory created successfully"),
            Err(e) => {
                println!("Failed to create directory: {}", e);
            }
        }

        let filename = format!("{}/{}/{}. {}.mp4", self.download_dir, folder, index, title);
        let stream_url = self.get_stream_url(url).await?.unwrap();


        let response = self.get_media_playlist(stream_url).await?;
        let mut file = std::fs::File::create(&filename)?;

        for media in response.segments {
            let media_response = self.download_media(media.uri).await?;
            file.write_all(&media_response)?;
        }

        Ok(())
    }
}
