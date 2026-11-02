//! TheCocktailDB drink → `Recipe` mapping.

use serde_json::{Map, Value};

use super::{collect_ingredients, field, instructions_to_markdown, split_tags};
use crate::models::{Kind, Recipe, Source, normalize_tags};

/// Guesses the preparation method from the instructions text.
pub(crate) fn guess_method(instructions: &str) -> Option<String> {
    let lower = instructions.to_lowercase();
    ["blend", "shake", "stir", "build"]
        .into_iter()
        .find(|m| lower.contains(m))
        .map(str::to_owned)
}

pub fn map_drink(item: &Map<String, Value>) -> Option<Recipe> {
    let id = field(item, "idDrink")?;
    let title = field(item, "strDrink")?;
    let category = field(item, "strCategory");
    let alcoholic = field(item, "strAlcoholic");
    let instructions = field(item, "strInstructions")
        .map(|s| instructions_to_markdown(&s))
        .unwrap_or_default();

    let mut tags = split_tags(field(item, "strTags"));
    tags.extend(category.clone());
    tags.extend(alcoholic.clone());

    let description = [category, alcoholic]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");

    Some(Recipe {
        id: None,
        method: guess_method(&instructions),
        title,
        kind: Kind::Cocktail,
        description,
        instructions,
        image_url: field(item, "strDrinkThumb"),
        servings: 1.0,
        glass: field(item, "strGlass"),
        garnish: None,
        tags: normalize_tags(tags),
        favorite: false,
        source: Source::Thecocktaildb,
        source_url: Some(format!("https://www.thecocktaildb.com/drink/{id}")),
        source_id: Some(id),
        parent_id: None,
        imported_id: None,
        ingredients: collect_ingredients(item, 15),
        created_at: None,
        updated_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external::{Upstream, parse_list};
    use serde_json::json;

    #[test]
    fn maps_margarita() {
        let body = json!({ "drinks": [{
            "idDrink": "11007",
            "strDrink": "Margarita",
            "strTags": "IBA,ContemporaryClassic",
            "strCategory": "Ordinary Drink",
            "strAlcoholic": "Alcoholic",
            "strGlass": "Cocktail glass",
            "strInstructions": "Rub the rim of the glass with the lime slice.\r\nShake the other ingredients with ice.",
            "strDrinkThumb": "https://www.thecocktaildb.com/images/media/drink/5noda61589575158.jpg",
            "strIngredient1": "Tequila", "strMeasure1": "1 1/2 oz ",
            "strIngredient2": "Triple sec", "strMeasure2": "1/2 oz ",
            "strIngredient3": "Lime juice", "strMeasure3": "1 oz ",
            "strIngredient4": "Salt", "strMeasure4": null,
            "strIngredient5": null, "strMeasure5": null,
            "strIngredient6": "", "strMeasure6": ""
        }]});
        let list = parse_list(Upstream::CocktailDb, &body).unwrap();
        assert_eq!(list.len(), 1);
        let r = &list[0];
        assert_eq!(r.title, "Margarita");
        assert_eq!(r.kind, Kind::Cocktail);
        assert_eq!(r.source_id.as_deref(), Some("11007"));
        assert_eq!(r.id, None);
        assert_eq!(
            r.tags,
            vec!["iba", "contemporaryclassic", "ordinary drink", "alcoholic"]
        );
        assert_eq!(r.ingredients.len(), 4);
        assert_eq!(r.ingredients[0].amount, Some(1.5));
        assert_eq!(r.ingredients[0].unit, "oz");
        assert_eq!(r.ingredients[3].amount, None);
        assert_eq!(r.method.as_deref(), Some("shake"));
        assert!(r.instructions.contains("\n\n"));
        assert_eq!(r.glass.as_deref(), Some("Cocktail glass"));
    }

    #[test]
    fn null_and_string_results_are_empty() {
        assert!(
            parse_list(Upstream::CocktailDb, &json!({ "drinks": null }))
                .unwrap()
                .is_empty()
        );
        assert!(
            parse_list(Upstream::CocktailDb, &json!({ "drinks": "no data found" }))
                .unwrap()
                .is_empty()
        );
        assert!(parse_list(Upstream::CocktailDb, &json!([])).is_err());
    }
}
