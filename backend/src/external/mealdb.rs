//! TheMealDB meal → `Recipe` mapping.

use serde_json::{Map, Value};

use super::{collect_ingredients, field, instructions_to_markdown, split_tags};
use crate::models::{Kind, Recipe, Source, normalize_tags};

/// TheMealDB does not state a yield; most of its recipes feed about four.
const DEFAULT_MEAL_SERVINGS: f64 = 4.0;

pub fn map_meal(item: &Map<String, Value>) -> Option<Recipe> {
    let id = field(item, "idMeal")?;
    let title = field(item, "strMeal")?;
    let category = field(item, "strCategory");
    let area = field(item, "strArea");

    let mut tags = split_tags(field(item, "strTags"));
    tags.extend(category.clone());
    tags.extend(area.clone());

    let description = [category, area]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");

    let source_url = field(item, "strSource")
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .unwrap_or_else(|| format!("https://www.themealdb.com/meal/{id}"));

    Some(Recipe {
        id: None,
        title,
        kind: Kind::Dish,
        description,
        instructions: field(item, "strInstructions")
            .map(|s| instructions_to_markdown(&s))
            .unwrap_or_default(),
        image_url: field(item, "strMealThumb"),
        servings: DEFAULT_MEAL_SERVINGS,
        glass: None,
        garnish: None,
        method: None,
        tags: normalize_tags(tags),
        favorite: false,
        source: Source::Themealdb,
        source_id: Some(id),
        source_url: Some(source_url),
        parent_id: None,
        imported_id: None,
        ingredients: collect_ingredients(item, 20),
        created_at: None,
        updated_at: None,
    })
}

#[cfg(test)]
mod tests {
    use crate::external::{Upstream, parse_list};
    use crate::models::Kind;
    use serde_json::json;

    #[test]
    fn maps_meal() {
        let body = json!({ "meals": [{
            "idMeal": "52772",
            "strMeal": "Teriyaki Chicken Casserole",
            "strCategory": "Chicken",
            "strArea": "Japanese",
            "strInstructions": "Preheat oven.\r\n\r\nCombine soy sauce.",
            "strMealThumb": "https://www.themealdb.com/images/media/meals/wvpsxx1468256321.jpg",
            "strTags": "Meat,Casserole",
            "strSource": "",
            "strIngredient1": "soy sauce", "strMeasure1": "3/4 cup",
            "strIngredient2": "garlic", "strMeasure2": "2 cloves",
            "strIngredient3": "chicken", "strMeasure3": "500g",
            "strIngredient4": "", "strMeasure4": ""
        }]});
        let r = parse_list(Upstream::MealDb, &body).unwrap().remove(0);
        assert_eq!(r.kind, Kind::Dish);
        assert_eq!(r.tags, vec!["meat", "casserole", "chicken", "japanese"]);
        assert_eq!(r.ingredients.len(), 3);
        assert_eq!(r.ingredients[0].amount, Some(0.75));
        assert_eq!(r.ingredients[1].unit, "clove");
        assert_eq!(r.ingredients[2].unit, "g");
        assert_eq!(r.instructions, "Preheat oven.\n\nCombine soy sauce.");
        assert_eq!(
            r.source_url.as_deref(),
            Some("https://www.themealdb.com/meal/52772")
        );
    }
}
