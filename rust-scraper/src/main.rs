
mod cms;

pub struct Category {
    url: String,
    name: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenv::dotenv().ok();
    let email = std::env::var("EMAIL").expect("EMAIL must be set");
    let password = std::env::var("PASSWORD").expect("PASSWORD must be set");
    let root_url = std::env::var("ROOT_URL").expect("ROOT_URL must be set");
    let download_dir = std::env::var("DOWNLOAD_DIR").expect("DOWNLOAD_DIR must be set");

    let categories = vec![
        Category{
            url: "/teach/control/stream/view/id/some_id".to_string(),
            name: "Parent dir name".to_string(),
        },

    ];

    let cms = cms::CmsClient::new(email, password, root_url, download_dir);
    cms.login().await?;
    for category in categories {
        println!("Downloading category{}", category.name.clone());

        let lessons = cms.get_links(category.url).await?;
        for i in 0..lessons.len() {
            let lesson = &lessons[i];
            cms.download_lesson(lesson, category.name.clone(), i).await?;
        }

    }

    Ok(())
}