//! First-run content: pages, a handful of house recipes and an active menu.

use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::models::{Ingredient, Kind, RecipeData, now_rfc3339};
use crate::repo::{self, Origin};

const HOME_TITLE: &str = "Добро пожаловать";
const HOME_BODY: &str = "\
# Мой домашний бар и кухня

Привет! Это маленький уголок, где я собираю всё, что люблю наливать и готовить для друзей: \
классические коктейли с выверенными пропорциями, мои собственные вариации и пару проверенных блюд, \
которые отлично идут под разговоры до поздней ночи.

## Как это работает

- Загляните в **меню** — там то, что я готов смешать прямо сейчас.
- Выберите напиток, напишите своё имя — и заказ прилетит мне за стойку.
- Хотите чего-то нового? Раздел **«Попробуйте»** подскажет случайный рецепт со всего света.

> Пейте с удовольствием, а не с размахом. Вода — лучший друг любого вечера.

*Этот текст — временный: хозяин бара скоро расскажет о себе сам.*
";

const ABOUT_TITLE: &str = "О баре";
const ABOUT_BODY: &str = "\
# О баре

Всё началось с одного шейкера, бутылки джина и желания угостить друзей чем-то лучше, \
чем «что было в холодильнике». Постепенно полка с бутылками выросла, появились джиггеры, \
барная ложка, лёд правильной формы — и тетрадка с рецептами, которая со временем превратилась в этот сайт.

## Принципы

1. **Точные пропорции.** Всё меряем в миллилитрах — так вкус повторяется от раза к разу.
2. **Свежие цитрусы.** Сок выжимается прямо перед приготовлением.
3. **Хороший лёд.** Много, холодный, без посторонних запахов.

*Здесь будет история бара, фотографии и любимые бутылки — текст скоро обновится.*
";

fn ing(name: &str, amount: Option<f64>, unit: &str, note: &str) -> Ingredient {
    Ingredient::new(name.to_owned(), amount, unit.to_owned(), note.to_owned())
}

#[allow(clippy::too_many_arguments)]
fn recipe(
    title: &str,
    kind: Kind,
    description: &str,
    instructions: &str,
    servings: f64,
    glass: Option<&str>,
    garnish: Option<&str>,
    method: Option<&str>,
    tags: &[&str],
    favorite: bool,
    ingredients: Vec<Ingredient>,
) -> RecipeData {
    RecipeData {
        title: title.to_owned(),
        kind,
        description: description.to_owned(),
        instructions: instructions.to_owned(),
        image_url: None,
        servings,
        glass: glass.map(str::to_owned),
        garnish: garnish.map(str::to_owned),
        method: method.map(str::to_owned),
        tags: tags.iter().map(|t| (*t).to_owned()).collect(),
        favorite: Some(favorite),
        ingredients,
    }
}

/// The house recipes. Menu entries reference them by title.
pub fn house_recipes() -> Vec<RecipeData> {
    use Kind::{Cocktail, Dish};
    vec![
        recipe(
            "Негрони",
            Cocktail,
            "Горько-сладкая итальянская классика в равных долях.",
            "1. Налейте все ингредиенты в смесительный стакан.\n\
             2. Наполните льдом и перемешивайте 20–30 секунд.\n\
             3. Процедите в охлаждённый рокс на крупный кубик льда.\n\
             4. Выжмите над бокалом апельсиновую цедру и опустите её внутрь.",
            1.0,
            Some("Рокс"),
            Some("Апельсиновая цедра"),
            Some("stir"),
            &["классика", "iba", "горький", "джин"],
            true,
            vec![
                ing("Джин", Some(30.0), "ml", "лондонский сухой"),
                ing("Кампари", Some(30.0), "ml", ""),
                ing("Красный вермут", Some(30.0), "ml", "rosso"),
            ],
        ),
        recipe(
            "Дайкири",
            Cocktail,
            "Ром, лайм и сахар — три ингредиента, идеальный баланс.",
            "1. Выжмите сок лайма непосредственно перед приготовлением.\n\
             2. Смешайте всё в шейкере, наполните льдом.\n\
             3. Энергично встряхивайте 10–12 секунд.\n\
             4. Дважды процедите в охлаждённое купе.",
            1.0,
            Some("Купе"),
            Some("Колесо лайма"),
            Some("shake"),
            &["классика", "iba", "кислый", "ром"],
            true,
            vec![
                ing("Белый ром", Some(60.0), "ml", ""),
                ing("Сок лайма", Some(25.0), "ml", "свежевыжатый"),
                ing("Сахарный сироп", Some(15.0), "ml", "1:1"),
            ],
        ),
        recipe(
            "Олд фэшн",
            Cocktail,
            "Бурбон, немного сахара и биттер — прародитель всех коктейлей.",
            "1. В смесительный стакан налейте сироп и биттер, добавьте бурбон.\n\
             2. Наполните льдом и перемешивайте около 30 секунд.\n\
             3. Процедите в рокс на большой кубик льда.\n\
             4. Сбрызните маслами апельсиновой цедры и украсьте ею.",
            1.0,
            Some("Рокс"),
            Some("Апельсиновая цедра"),
            Some("stir"),
            &["классика", "iba", "виски", "крепкий"],
            false,
            vec![
                ing("Бурбон", Some(60.0), "ml", ""),
                ing("Сахарный сироп", Some(7.5), "ml", "2:1"),
                ing("Ангостура", Some(2.0), "dash", ""),
            ],
        ),
        recipe(
            "Маргарита",
            Cocktail,
            "Текила, апельсиновый ликёр и лайм с солёным ободком.",
            "1. Сделайте солёный ободок на половине края охлаждённого бокала.\n\
             2. Смешайте ингредиенты в шейкере со льдом.\n\
             3. Встряхивайте 10–12 секунд.\n\
             4. Дважды процедите в бокал.",
            1.0,
            Some("Купе"),
            Some("Соль на ободке, долька лайма"),
            Some("shake"),
            &["классика", "iba", "кислый", "текила"],
            false,
            vec![
                ing("Текила бланко", Some(50.0), "ml", "100% агава"),
                ing("Трипл сек", Some(20.0), "ml", "Cointreau"),
                ing("Сок лайма", Some(25.0), "ml", "свежевыжатый"),
                ing("Соль", None, "", "для ободка"),
            ],
        ),
        recipe(
            "Виски сауэр",
            Cocktail,
            "Бархатный кислый коктейль с пеной из белка.",
            "1. Смешайте все ингредиенты, кроме биттера, в шейкере без льда и встряхните 10 секунд (dry shake).\n\
             2. Добавьте лёд и встряхивайте ещё 10–12 секунд.\n\
             3. Процедите в рокс со льдом.\n\
             4. Капните ангостуру на пену и украсьте вишней.",
            1.0,
            Some("Рокс"),
            Some("Коктейльная вишня, капли ангостуры"),
            Some("shake"),
            &["классика", "iba", "кислый", "виски"],
            false,
            vec![
                ing("Бурбон", Some(60.0), "ml", ""),
                ing("Сок лимона", Some(30.0), "ml", "свежевыжатый"),
                ing("Сахарный сироп", Some(20.0), "ml", "1:1"),
                ing(
                    "Яичный белок",
                    Some(20.0),
                    "ml",
                    "≈ от одного небольшого яйца",
                ),
                ing("Ангостура", Some(2.0), "dash", "сверху"),
            ],
        ),
        recipe(
            "Апероль шприц",
            Cocktail,
            "Лёгкий оранжевый аперитив для долгих летних вечеров.",
            "1. Наполните бокал для вина льдом.\n\
             2. Налейте просекко, затем апероль.\n\
             3. Долейте содовую и аккуратно перемешайте одним движением.\n\
             4. Украсьте долькой апельсина.",
            1.0,
            Some("Бокал для вина"),
            Some("Долька апельсина"),
            Some("build"),
            &["аперитив", "iba", "игристое", "лёгкий"],
            false,
            vec![
                ing("Просекко", Some(90.0), "ml", "охлаждённое"),
                ing("Апероль", Some(60.0), "ml", ""),
                ing("Содовая", Some(30.0), "ml", ""),
            ],
        ),
        recipe(
            "Мохито",
            Cocktail,
            "Освежающий кубинский хайбол с мятой и лаймом.",
            "1. В хайболе слегка помните мяту с сиропом и соком лайма — не растирайте листья в кашу.\n\
             2. Добавьте ром и наполните бокал колотым льдом.\n\
             3. Перемешайте барной ложкой снизу вверх.\n\
             4. Долейте содовую, добавьте ещё льда и украсьте веточкой мяты.",
            1.0,
            Some("Хайбол"),
            Some("Веточка мяты, долька лайма"),
            Some("build"),
            &["классика", "iba", "освежающий", "ром"],
            false,
            vec![
                ing("Белый ром", Some(50.0), "ml", ""),
                ing("Сок лайма", Some(25.0), "ml", "свежевыжатый"),
                ing("Сахарный сироп", Some(20.0), "ml", "1:1"),
                ing("Мята", Some(10.0), "leaf", "свежая"),
                ing("Содовая", Some(60.0), "ml", "долить"),
            ],
        ),
        recipe(
            "Шакшука",
            Dish,
            "Яйца, томлённые в пряном томатном соусе с перцем.",
            "1. Разогрейте масло в сковороде, обжарьте нарезанный лук и перец 6–8 минут до мягкости.\n\
             2. Добавьте чеснок, паприку и кумин, прогрейте 30 секунд.\n\
             3. Влейте томаты, разомните их, посолите и томите 10 минут до загустения.\n\
             4. Сделайте в соусе углубления, вбейте яйца, накройте крышкой и готовьте 5–7 минут, пока белок не схватится.\n\
             5. Посыпьте зеленью и подавайте прямо в сковороде с хлебом.",
            2.0,
            None,
            Some("Кинза или петрушка"),
            None,
            &["завтрак", "яйца", "вегетарианское"],
            false,
            vec![
                ing("Оливковое масло", Some(2.0), "tbsp", ""),
                ing("Лук репчатый", Some(1.0), "pcs", "средний"),
                ing("Сладкий перец", Some(1.0), "pcs", "красный"),
                ing("Чеснок", Some(2.0), "clove", ""),
                ing("Томаты в собственном соку", Some(400.0), "g", ""),
                ing("Яйца", Some(4.0), "pcs", ""),
                ing("Копчёная паприка", Some(1.0), "tsp", ""),
                ing("Кумин молотый", Some(0.5), "tsp", ""),
                ing("Соль и чёрный перец", None, "", "по вкусу"),
            ],
        ),
        recipe(
            "Гуакамоле",
            Dish,
            "Закуска к коктейлям: спелый авокадо, лайм и кинза.",
            "1. Разомните мякоть авокадо вилкой, оставляя небольшие кусочки.\n\
             2. Добавьте мелко нарезанный лук, халапеньо и кинзу.\n\
             3. Влейте сок лайма, посолите и перемешайте.\n\
             4. Подавайте сразу с кукурузными чипсами.",
            4.0,
            None,
            Some("Кинза"),
            None,
            &["закуска", "вегетарианское", "к коктейлям"],
            false,
            vec![
                ing("Авокадо", Some(2.0), "pcs", "спелые"),
                ing("Сок лайма", Some(15.0), "ml", ""),
                ing("Красный лук", Some(30.0), "g", "мелко нарезанный"),
                ing("Кинза", Some(10.0), "g", ""),
                ing("Халапеньо", Some(0.5), "pcs", "без семян"),
                ing("Соль", Some(0.5), "tsp", ""),
            ],
        ),
    ]
}

/// Titles of house recipes placed on the initial active menu.
const MENU_TITLES: [&str; 5] = [
    "Негрони",
    "Дайкири",
    "Маргарита",
    "Виски сауэр",
    "Апероль шприц",
];

/// Seeds content when the database is completely empty. Returns whether it seeded.
pub async fn seed_if_empty(pool: &SqlitePool) -> AppResult<bool> {
    let mut tx = crate::db::begin_write(pool).await?;
    let existing: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM recipes) + (SELECT COUNT(*) FROM pages) + (SELECT COUNT(*) FROM menus)",
    )
    .fetch_one(&mut *tx)
    .await?;
    if existing > 0 {
        return Ok(false);
    }
    let now = now_rfc3339();
    for (slug, title, body) in [
        ("home", HOME_TITLE, HOME_BODY),
        ("about", ABOUT_TITLE, ABOUT_BODY),
    ] {
        sqlx::query("INSERT INTO pages (slug, title, body, updated_at) VALUES (?, ?, ?, ?)")
            .bind(slug)
            .bind(title)
            .bind(body)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }

    let mut ids = std::collections::HashMap::new();
    for data in house_recipes() {
        let id = repo::insert_recipe(&mut tx, &data, &Origin::default()).await?;
        ids.insert(data.title.clone(), id);
    }

    let menu_id: i64 = sqlx::query_scalar(
        "INSERT INTO menus (title, description, is_active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?) RETURNING id",
    )
    .bind("Сегодня в баре")
    .bind("Что я готов смешать для вас этим вечером.")
    .bind(&now)
    .bind(&now)
    .fetch_one(&mut *tx)
    .await?;
    for (pos, title) in MENU_TITLES.iter().enumerate() {
        if let Some(id) = ids.get(*title) {
            sqlx::query(
                "INSERT INTO menu_items (menu_id, recipe_id, position, note) VALUES (?, ?, ?, '')",
            )
            .bind(menu_id)
            .bind(id)
            .bind(pos as i64)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    tracing::info!("seeded first-run content");
    Ok(true)
}
