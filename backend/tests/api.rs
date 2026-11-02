//! Integration tests: the full router against a temporary SQLite database.
//! No test touches the real internet; discover tests use a local mock upstream.

use std::collections::HashMap;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

use homebar::auth::derive_token;
use homebar::config::Config;
use homebar::{AppState, build_app, db, seed};

const PASSWORD: &str = "test-password";

struct TestApp {
    app: Router,
    token: String,
    pool: sqlx::SqlitePool,
    _dir: TempDir,
}

struct Resp {
    status: StatusCode,
    json: Value,
    headers: axum::http::HeaderMap,
}

async fn setup_with(seeded: bool, extra: &[(&str, &str)]) -> TestApp {
    let dir = TempDir::new().expect("tempdir");
    let mut env: HashMap<String, String> = HashMap::from([
        ("DATA_DIR".into(), dir.path().display().to_string()),
        (
            "STATIC_DIR".into(),
            dir.path().join("no-static").display().to_string(),
        ),
        ("ADMIN_PASSWORD".into(), PASSWORD.into()),
        ("EXTERNAL_TIMEOUT_SECS".into(), "2".into()),
        // Unroutable by default: discover tests must opt into a mock.
        ("COCKTAILDB_BASE_URL".into(), "http://127.0.0.1:9/".into()),
        ("MEALDB_BASE_URL".into(), "http://127.0.0.1:9/".into()),
    ]);
    for (k, v) in extra {
        env.insert((*k).into(), (*v).into());
    }
    let config = Config::from_lookup(|k| env.get(k).cloned());
    std::fs::create_dir_all(config.uploads_dir()).unwrap();
    let pool = db::connect(&config.db_path()).await.expect("db");
    if seeded {
        assert!(seed::seed_if_empty(&pool).await.unwrap());
    }
    let state = AppState::new(pool.clone(), config).unwrap();
    TestApp {
        app: build_app(state),
        token: derive_token(PASSWORD),
        pool,
        _dir: dir,
    }
}

async fn setup(seeded: bool) -> TestApp {
    setup_with(seeded, &[]).await
}

impl TestApp {
    async fn send(&self, req: Request<Body>) -> Resp {
        let res = self.app.clone().oneshot(req).await.expect("infallible");
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        Resp {
            status,
            json,
            headers,
        }
    }

    async fn call(&self, method: Method, uri: &str, body: Option<Value>, admin: bool) -> Resp {
        let mut req = Request::builder().method(method).uri(uri);
        if admin {
            req = req.header(header::AUTHORIZATION, format!("Bearer {}", self.token));
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        self.send(req).await
    }

    async fn get(&self, uri: &str) -> Resp {
        self.call(Method::GET, uri, None, false).await
    }

    async fn admin(&self, method: Method, uri: &str, body: Option<Value>) -> Resp {
        self.call(method, uri, body, true).await
    }
}

fn negroni_input() -> Value {
    json!({
        "title": "Test Negroni",
        "kind": "cocktail",
        "description": "bitter",
        "instructions": "Stir.",
        "servings": 1,
        "glass": "Rocks",
        "method": "stir",
        "tags": [" Classic ", "classic", "Bitter", ""],
        "ingredients": [
            { "name": "Gin", "amount": 30, "unit": "ml", "note": "" },
            { "name": "Campari", "amount": 30, "unit": "ml", "note": "" },
            { "name": "Vermouth", "amount": 30, "unit": "ml", "note": "rosso" }
        ]
    })
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_and_seed_content() {
    let t = setup(true).await;
    let r = t.get("/api/health").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["ok"], true);
    assert!(r.json["version"].is_string());

    let pages = t.get("/api/pages").await.json;
    let slugs: Vec<&str> = pages
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["slug"].as_str().unwrap())
        .collect();
    assert_eq!(slugs, vec!["about", "home"]);

    let recipes = t.get("/api/recipes").await.json;
    let list = recipes.as_array().unwrap();
    assert!(list.len() >= 8);
    // Favorites come first.
    assert_eq!(list[0]["favorite"], true);
    assert!(list[0]["ingredientNames"].as_array().unwrap().len() >= 3);

    let menu = t.get("/api/menus/active").await;
    assert_eq!(menu.status, StatusCode::OK);
    assert_eq!(menu.json["title"], "Сегодня в баре");
    assert_eq!(menu.json["isActive"], true);
    assert_eq!(menu.json["items"].as_array().unwrap().len(), 5);
    assert_eq!(menu.json["itemCount"], 5);
    assert_eq!(menu.json["items"][0]["position"], 0);
    assert!(menu.json["items"][0]["recipe"]["title"].is_string());

    let stats = t.get("/api/stats").await.json;
    assert_eq!(stats["recipes"], list.len());
    assert_eq!(stats["favorites"], 2);
    assert_eq!(stats["own"], list.len());
    assert_eq!(stats["imported"], 0);
    assert_eq!(stats["ordersToday"], 0);
    assert_eq!(
        stats["cocktails"].as_i64().unwrap() + stats["dishes"].as_i64().unwrap(),
        stats["recipes"].as_i64().unwrap()
    );
}

#[tokio::test]
async fn auth_login_me_and_rejection() {
    let t = setup(false).await;
    let bad = t
        .call(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "password": "nope" })),
            false,
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNAUTHORIZED);
    assert!(bad.json["error"].is_string());
    // Failed logins are throttled (brute-force protection).
    let started = std::time::Instant::now();
    t.call(
        Method::POST,
        "/api/auth/login",
        Some(json!({ "password": "nope2" })),
        false,
    )
    .await;
    assert!(started.elapsed() >= std::time::Duration::from_millis(450));

    let ok = t
        .call(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "password": PASSWORD })),
            false,
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.json["token"], t.token);

    assert_eq!(t.get("/api/auth/me").await.json["admin"], false);
    let me = t.call(Method::GET, "/api/auth/me", None, true).await;
    assert_eq!(me.json["admin"], true);

    // Admin endpoints without / with a wrong token.
    let r = t
        .call(Method::POST, "/api/recipes", Some(negroni_input()), false)
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(r.json["error"].is_string());
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/recipes")
        .header(header::AUTHORIZATION, "Bearer deadbeef")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(negroni_input().to_string()))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.get("/api/orders").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        t.call(Method::DELETE, "/api/menus/1", None, false)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn recipe_lifecycle_versions_restore_fork_delete() {
    let t = setup(false).await;

    // Create.
    let created = t
        .admin(Method::POST, "/api/recipes", Some(negroni_input()))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.json);
    let r = &created.json;
    let id = r["id"].as_i64().unwrap();
    assert_eq!(r["source"], "own");
    assert_eq!(r["tags"], json!(["classic", "bitter"]));
    assert_eq!(r["ingredients"].as_array().unwrap().len(), 3);
    assert_eq!(r["ingredients"][2]["note"], "rosso");
    assert_eq!(r["favorite"], false);
    assert_eq!(r["importedId"], Value::Null);
    assert_eq!(r["parentId"], Value::Null);
    assert!(r["createdAt"].is_string());

    // Update creates a version snapshot of the previous state.
    let mut input = negroni_input();
    input["title"] = json!("Negroni v2");
    input["versionNote"] = json!("more gin");
    input["ingredients"][0]["amount"] = json!(40);
    let updated = t
        .admin(Method::PUT, &format!("/api/recipes/{id}"), Some(input))
        .await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.json);
    assert_eq!(updated.json["title"], "Negroni v2");
    assert_eq!(updated.json["ingredients"][0]["amount"], 40.0);
    assert_eq!(updated.json["source"], "own");

    let versions = t.get(&format!("/api/recipes/{id}/versions")).await.json;
    let versions = versions.as_array().unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0]["note"], "more gin");
    assert_eq!(versions[0]["title"], "Test Negroni");
    assert_eq!(versions[0]["recipeId"], id);
    let vid = versions[0]["id"].as_i64().unwrap();

    let version = t.get(&format!("/api/recipes/{id}/versions/{vid}")).await;
    assert_eq!(version.status, StatusCode::OK);
    assert_eq!(version.json["recipe"]["title"], "Test Negroni");
    assert_eq!(version.json["recipe"]["ingredients"][0]["amount"], 30.0);
    assert_eq!(version.json["note"], "more gin");

    // Restore: current state is snapshotted first.
    let restored = t
        .admin(
            Method::POST,
            &format!("/api/recipes/{id}/versions/{vid}/restore"),
            None,
        )
        .await;
    assert_eq!(restored.status, StatusCode::OK, "{}", restored.json);
    assert_eq!(restored.json["title"], "Test Negroni");
    assert_eq!(restored.json["ingredients"][0]["amount"], 30.0);
    let versions = t.get(&format!("/api/recipes/{id}/versions")).await.json;
    let versions = versions.as_array().unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0]["note"], "before restore");
    assert_eq!(versions[0]["title"], "Negroni v2");

    // Wrong recipe/version combination → 404.
    assert_eq!(
        t.get(&format!("/api/recipes/{}/versions/{vid}", id + 100))
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // Fork (no body).
    let fork = t
        .admin(Method::POST, &format!("/api/recipes/{id}/fork"), None)
        .await;
    assert_eq!(fork.status, StatusCode::CREATED, "{}", fork.json);
    assert_eq!(fork.json["title"], "Test Negroni (вариация)");
    assert_eq!(fork.json["parentId"], id);
    assert_eq!(fork.json["source"], "own");
    assert_eq!(fork.json["ingredients"].as_array().unwrap().len(), 3);
    let fork_id = fork.json["id"].as_i64().unwrap();

    // Fork with a custom title.
    let fork2 = t
        .admin(
            Method::POST,
            &format!("/api/recipes/{id}/fork"),
            Some(json!({ "title": "Mezcal Negroni" })),
        )
        .await;
    assert_eq!(fork2.status, StatusCode::CREATED);
    assert_eq!(fork2.json["title"], "Mezcal Negroni");

    // Delete the original: 204, then 404; the fork survives with parentId null.
    let del = t
        .admin(Method::DELETE, &format!("/api/recipes/{id}"), None)
        .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert_eq!(
        t.get(&format!("/api/recipes/{id}")).await.status,
        StatusCode::NOT_FOUND
    );
    let fork_now = t.get(&format!("/api/recipes/{fork_id}")).await;
    assert_eq!(fork_now.status, StatusCode::OK);
    assert_eq!(fork_now.json["parentId"], Value::Null);
    assert_eq!(
        t.admin(Method::DELETE, &format!("/api/recipes/{id}"), None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn recipe_validation_errors_are_json_400() {
    let t = setup(false).await;
    for body in [
        json!({ "title": "", "kind": "cocktail" }),
        json!({ "title": "x", "kind": "beverage" }),
        json!({ "title": "x", "kind": "cocktail", "servings": 0 }),
        json!({ "title": "x".repeat(201), "kind": "cocktail" }),
        json!({ "kind": "cocktail" }),
    ] {
        let r = t.admin(Method::POST, "/api/recipes", Some(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json);
        assert!(r.json["error"].is_string(), "{}", r.json);
    }
    let r = t.get("/api/recipes?kind=beverage").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = t.get("/api/recipes/abc").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.json["error"].is_string());
    let r = t.get("/api/nope").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(r.json["error"].is_string());
}

#[tokio::test]
async fn favorite_filter_search_tags() {
    let t = setup(false).await;
    let mut ids = Vec::new();
    for (title, tags) in [
        ("Белый русский", vec!["Сливочный", "водка"]),
        ("Gimlet", vec!["gin", "sour"]),
        ("Gin Fizz", vec!["gin"]),
    ] {
        let mut input = negroni_input();
        input["title"] = json!(title);
        input["tags"] = json!(tags);
        let r = t.admin(Method::POST, "/api/recipes", Some(input)).await;
        assert_eq!(r.status, StatusCode::CREATED);
        ids.push(r.json["id"].as_i64().unwrap());
    }

    let fav = t
        .admin(
            Method::PUT,
            &format!("/api/recipes/{}/favorite", ids[1]),
            Some(json!({ "favorite": true })),
        )
        .await;
    assert_eq!(fav.status, StatusCode::OK);
    assert_eq!(fav.json["favorite"], true);
    // Favorite toggles do not create versions.
    let v = t
        .get(&format!("/api/recipes/{}/versions", ids[1]))
        .await
        .json;
    assert_eq!(v.as_array().unwrap().len(), 0);

    let favs = t.get("/api/recipes?favorite=true").await.json;
    let favs = favs.as_array().unwrap();
    assert_eq!(favs.len(), 1);
    assert_eq!(favs[0]["title"], "Gimlet");

    // Favorites first in the unfiltered list; empty params are ignored.
    let all = t.get("/api/recipes?q=&kind=&tag=&source=").await.json;
    assert_eq!(all.as_array().unwrap().len(), 3);
    assert_eq!(all[0]["title"], "Gimlet");

    // Case-insensitive Cyrillic search on title; ingredient-name search.
    let r = t
        .get("/api/recipes?q=%D0%B1%D0%B5%D0%BB%D1%8B%D0%B9") // "белый"
        .await
        .json;
    assert_eq!(r.as_array().unwrap().len(), 1);
    let r = t.get("/api/recipes?q=CAMPARI").await.json;
    assert_eq!(r.as_array().unwrap().len(), 3);

    let r = t.get("/api/recipes?tag=GIN").await.json;
    assert_eq!(r.as_array().unwrap().len(), 2);
    let r = t.get("/api/recipes?source=imported").await.json;
    assert_eq!(r.as_array().unwrap().len(), 0);
    let r = t.get("/api/recipes?source=own&kind=cocktail").await.json;
    assert_eq!(r.as_array().unwrap().len(), 3);

    let tags = t.get("/api/tags").await.json;
    assert_eq!(tags[0], json!({ "tag": "gin", "count": 2 }));
    let names: Vec<&str> = tags
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["tag"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["gin", "sour", "водка", "сливочный"]);
}

async fn create_menu(t: &TestApp, title: &str) -> i64 {
    let r = t
        .admin(Method::POST, "/api/menus", Some(json!({ "title": title })))
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    assert_eq!(r.json["isActive"], false);
    assert_eq!(r.json["description"], "");
    r.json["id"].as_i64().unwrap()
}

#[tokio::test]
async fn menu_activation_is_exclusive() {
    let t = setup(false).await;
    assert_eq!(
        t.get("/api/menus/active").await.status,
        StatusCode::NOT_FOUND
    );
    let a = create_menu(&t, "A").await;
    let b = create_menu(&t, "B").await;

    let r = t
        .admin(Method::POST, &format!("/api/menus/{a}/activate"), None)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["isActive"], true);
    let r = t
        .admin(Method::POST, &format!("/api/menus/{b}/activate"), None)
        .await;
    assert_eq!(r.json["isActive"], true);

    let menus = t.get("/api/menus").await.json;
    let active: Vec<i64> = menus
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["isActive"] == true)
        .map(|m| m["id"].as_i64().unwrap())
        .collect();
    assert_eq!(active, vec![b]);
    assert_eq!(t.get("/api/menus/active").await.json["id"], b);

    // Re-activating the same menu keeps exactly one active.
    t.admin(Method::POST, &format!("/api/menus/{b}/activate"), None)
        .await;
    assert_eq!(
        t.get(&format!("/api/menus/{a}")).await.json["isActive"],
        false
    );

    let r = t
        .admin(Method::POST, &format!("/api/menus/{b}/deactivate"), None)
        .await;
    assert_eq!(r.json["isActive"], false);
    assert_eq!(
        t.get("/api/menus/active").await.status,
        StatusCode::NOT_FOUND
    );

    // Update + delete.
    let r = t
        .admin(
            Method::PUT,
            &format!("/api/menus/{a}"),
            Some(json!({ "title": "A2", "description": "d" })),
        )
        .await;
    assert_eq!(r.json["title"], "A2");
    assert_eq!(r.json["description"], "d");
    assert_eq!(
        t.admin(Method::DELETE, &format!("/api/menus/{a}"), None)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        t.get(&format!("/api/menus/{a}")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.admin(Method::POST, "/api/menus/999/activate", None)
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn orders_must_be_in_menu_and_flow() {
    let t = setup(false).await;
    let x = t
        .admin(Method::POST, "/api/recipes", Some(negroni_input()))
        .await
        .json["id"]
        .as_i64()
        .unwrap();
    let mut other = negroni_input();
    other["title"] = json!("Other");
    let y = t
        .admin(Method::POST, "/api/recipes", Some(other))
        .await
        .json["id"]
        .as_i64()
        .unwrap();
    let menu = create_menu(&t, "Tonight").await;
    let items = t
        .admin(
            Method::PUT,
            &format!("/api/menus/{menu}/items"),
            Some(json!({ "items": [ { "recipeId": x, "note": "house" }, { "recipeId": x } ] })),
        )
        .await;
    assert_eq!(items.status, StatusCode::OK, "{}", items.json);
    assert_eq!(items.json["itemCount"], 1);
    assert_eq!(items.json["items"][0]["note"], "house");
    assert_eq!(items.json["items"][0]["recipe"]["id"], x);

    // Unknown recipe in items → 400.
    let r = t
        .admin(
            Method::PUT,
            &format!("/api/menus/{menu}/items"),
            Some(json!({ "items": [ { "recipeId": 9999 } ] })),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Not on the menu → 400.
    let r = t
        .call(
            Method::POST,
            "/api/orders",
            Some(json!({ "recipeId": y, "menuId": menu, "guestName": "Аня" })),
            false,
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json);
    assert!(r.json["error"].is_string());

    // Guest name validation.
    for name in ["", "   ", &"x".repeat(61)] {
        let r = t
            .call(
                Method::POST,
                "/api/orders",
                Some(json!({ "recipeId": x, "guestName": name })),
                false,
            )
            .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
    }

    // On the menu → 201, public (no token), broadcast-able.
    let r = t
        .call(
            Method::POST,
            "/api/orders",
            Some(
                json!({ "recipeId": x, "menuId": menu, "guestName": " Аня ", "note": "less ice" }),
            ),
            false,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    assert_eq!(r.json["status"], "new");
    assert_eq!(r.json["guestName"], "Аня");
    assert_eq!(r.json["recipeTitle"], "Test Negroni");
    assert_eq!(r.json["menuId"], menu);
    let order_id = r.json["id"].as_i64().unwrap();

    // Without menuId any recipe is accepted.
    let r2 = t
        .call(
            Method::POST,
            "/api/orders",
            Some(json!({ "recipeId": y, "guestName": "Боря" })),
            false,
        )
        .await;
    assert_eq!(r2.status, StatusCode::CREATED);

    // Guest can poll their order.
    let got = t.get(&format!("/api/orders/{order_id}")).await;
    assert_eq!(got.status, StatusCode::OK);
    assert_eq!(got.json["id"], order_id);

    // Host workflow.
    let active = t.admin(Method::GET, "/api/orders", None).await.json;
    assert_eq!(active.as_array().unwrap().len(), 2);
    assert_eq!(active[0]["id"], order_id, "active list is oldest first");
    let patched = t
        .admin(
            Method::PATCH,
            &format!("/api/orders/{order_id}"),
            Some(json!({ "status": "done" })),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK);
    assert_eq!(patched.json["status"], "done");
    let bad = t
        .admin(
            Method::PATCH,
            &format!("/api/orders/{order_id}"),
            Some(json!({ "status": "eaten" })),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let active = t
        .admin(Method::GET, "/api/orders?status=active", None)
        .await
        .json;
    assert_eq!(active.as_array().unwrap().len(), 1);
    let all = t
        .admin(Method::GET, "/api/orders?status=all", None)
        .await
        .json;
    assert_eq!(all.as_array().unwrap().len(), 2);
    assert_eq!(all[1]["id"], order_id, "all list is newest first");
    assert_eq!(t.get("/api/stats").await.json["ordersToday"], 2);

    // Deleting the recipe removes it from menus; orders keep their title.
    t.admin(Method::DELETE, &format!("/api/recipes/{x}"), None)
        .await;
    let m = t.get(&format!("/api/menus/{menu}")).await.json;
    assert_eq!(m["itemCount"], 0);
    let got = t.get(&format!("/api/orders/{order_id}")).await;
    assert_eq!(got.json["recipeTitle"], "Test Negroni");
    assert_eq!(got.json["recipeId"], x);
}

#[tokio::test]
async fn order_stream_auth() {
    let t = setup(false).await;
    let r = t.get("/api/orders/stream").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t.get("/api/orders/stream?token=wrong").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // Valid query token: only check headers; the body is an endless stream.
    let req = Request::builder()
        .uri(format!("/api/orders/stream?v=1&token={}", t.token))
        .body(Body::empty())
        .unwrap();
    let res = t.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()[header::CONTENT_TYPE].to_str().unwrap(),
        "text/event-stream"
    );
    assert_eq!(res.headers()["x-accel-buffering"], "no");
}

#[tokio::test]
async fn sse_delivers_order_events() {
    let t = setup(false).await;
    let x = t
        .admin(Method::POST, "/api/recipes", Some(negroni_input()))
        .await
        .json["id"]
        .as_i64()
        .unwrap();
    let req = Request::builder()
        .uri("/api/orders/stream")
        .header(header::AUTHORIZATION, format!("Bearer {}", t.token))
        .body(Body::empty())
        .unwrap();
    let res = t.app.clone().oneshot(req).await.unwrap();
    let mut body = res.into_body();

    t.call(
        Method::POST,
        "/api/orders",
        Some(json!({ "recipeId": x, "guestName": "Ваня" })),
        false,
    )
    .await;

    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
        .await
        .expect("event within timeout")
        .expect("stream open")
        .expect("frame ok");
    let text = String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap();
    assert!(text.starts_with("event: order\n"), "{text}");
    let data = text.lines().find_map(|l| l.strip_prefix("data: ")).unwrap();
    let order: Value = serde_json::from_str(data).unwrap();
    assert_eq!(order["guestName"], "Ваня");
}

#[tokio::test]
async fn page_upsert() {
    let t = setup(true).await;
    let home = t.get("/api/pages/home").await;
    assert_eq!(home.status, StatusCode::OK);
    assert!(home.json["body"].as_str().unwrap().contains('#'));

    assert_eq!(t.get("/api/pages/faq").await.status, StatusCode::NOT_FOUND);
    let r = t
        .admin(
            Method::PUT,
            "/api/pages/faq",
            Some(json!({ "title": "FAQ", "body": "# Вопросы" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    assert_eq!(r.json["slug"], "faq");
    let r = t
        .admin(
            Method::PUT,
            "/api/pages/faq",
            Some(json!({ "title": "FAQ 2", "body": "updated" })),
        )
        .await;
    assert_eq!(r.json["title"], "FAQ 2");
    let got = t.get("/api/pages/faq").await.json;
    assert_eq!(got["body"], "updated");
    assert_eq!(t.get("/api/pages").await.json.as_array().unwrap().len(), 3);

    let bad = t
        .admin(
            Method::PUT,
            "/api/pages/Bad_Slug",
            Some(json!({ "title": "x", "body": "" })),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let unauth = t
        .call(
            Method::PUT,
            "/api/pages/home",
            Some(json!({ "title": "x", "body": "" })),
            false,
        )
        .await;
    assert_eq!(unauth.status, StatusCode::UNAUTHORIZED);
}

fn multipart(name: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = "XhomebarBoundaryX";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"a.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[tokio::test]
async fn uploads_sniff_and_serve() {
    let t = setup(false).await;
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0";
    let (ct, body) = multipart("file", png);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/uploads")
        .header(header::AUTHORIZATION, format!("Bearer {}", t.token))
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(body))
        .unwrap();
    let r = t.send(req).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.json);
    let url = r.json["url"].as_str().unwrap().to_owned();
    assert!(
        url.starts_with("/uploads/") && url.ends_with(".png"),
        "{url}"
    );

    let res = t
        .app
        .clone()
        .oneshot(Request::builder().uri(&url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert!(
        res.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable")
    );

    // A missing upload must not be cached forever.
    let res = t
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/uploads/00000000-0000-0000-0000-000000000000.png")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert!(res.headers().get(header::CACHE_CONTROL).is_none());

    // Not an image (even if the client claims so).
    let (ct, body) = multipart("file", b"<svg onload=alert(1)>");
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/uploads")
        .header(header::AUTHORIZATION, format!("Bearer {}", t.token))
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(body))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::BAD_REQUEST);

    // Unauthenticated.
    let (ct, body) = multipart("file", png);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/uploads")
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(body))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::UNAUTHORIZED);

    // Too large (> 8 MB).
    let mut big = png.to_vec();
    big.resize(8 * 1024 * 1024 + 10, 0);
    let (ct, body) = multipart("file", &big);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/uploads")
        .header(header::AUTHORIZATION, format!("Bearer {}", t.token))
        .header(header::CONTENT_TYPE, ct)
        .body(Body::from(body))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::PAYLOAD_TOO_LARGE);
}

// ---------------------------------------------------------------------------
// Discover (local mock upstream, never the real internet)
// ---------------------------------------------------------------------------

fn drink(id: &str, name: &str) -> Value {
    json!({
        "idDrink": id, "strDrink": name, "strCategory": "Cocktail", "strAlcoholic": "Alcoholic",
        "strTags": "IBA", "strGlass": "Coupe", "strInstructions": "Shake well.",
        "strDrinkThumb": format!("https://example.invalid/{id}.jpg"),
        "strIngredient1": "Gin", "strMeasure1": "1 1/2 oz",
        "strIngredient2": "Lemon", "strMeasure2": "Juice of 1",
        "strIngredient3": "Soda", "strMeasure3": "top up"
    })
}

/// Serves a tiny TheCocktailDB look-alike on an ephemeral port.
async fn mock_upstream() -> String {
    use axum::extract::Query;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let counter = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/random.php",
            get(move || {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                // Only three distinct drinks: forces deduplication.
                let id = 1000 + (n % 3);
                async move {
                    axum::Json(
                        json!({ "drinks": [drink(&id.to_string(), &format!("Drink {id}"))] }),
                    )
                }
            }),
        )
        .route(
            "/lookup.php",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                let id = q.get("i").cloned().unwrap_or_default();
                match id.as_str() {
                    "404" => axum::Json(json!({ "drinks": null })).into_response(),
                    // TheCocktailDB answers some misses with an empty 200 body.
                    "204" => "".into_response(),
                    "777" => {
                        // Oversized upstream data: must still be editable after import.
                        let mut d = drink(&id, &"Long ".repeat(60));
                        let tags: Vec<String> = (0..40).map(|i| format!("tag{i}")).collect();
                        d["strTags"] = json!(format!("{},{}", "x".repeat(50), tags.join(",")));
                        d["strMeasure1"] = json!("9".repeat(400));
                        axum::Json(json!({ "drinks": [d] })).into_response()
                    }
                    _ => axum::Json(json!({ "drinks": [drink(&id, "Looked Up")] })).into_response(),
                }
            }),
        )
        .route(
            "/search.php",
            get(|| async { axum::Json(json!({ "drinks": [drink("1", "A"), drink("2", "B")] })) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}/")
}

#[tokio::test]
async fn discover_with_mock_upstream() {
    let base = mock_upstream().await;
    let t = setup_with(false, &[("COCKTAILDB_BASE_URL", base.as_str())]).await;

    let r = t.get("/api/discover/random?kind=cocktail&count=5").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    let list = r.json.as_array().unwrap();
    assert_eq!(list.len(), 3, "deduplicated by sourceId");
    assert!(
        list.iter()
            .all(|d| d["id"].is_null() && d["importedId"].is_null())
    );
    assert_eq!(list[0]["ingredients"][0]["amount"], 1.5);
    assert_eq!(list[0]["ingredients"][0]["unit"], "oz");
    assert_eq!(list[0]["ingredients"][2]["amount"], Value::Null);
    assert_eq!(list[0]["ingredients"][2]["note"], "top up");

    assert_eq!(
        t.get("/api/discover/random?kind=cocktail&count=13")
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    let s = t.get("/api/discover/search?q=gin&kind=cocktail").await;
    assert_eq!(s.json.as_array().unwrap().len(), 2);
    assert_eq!(
        t.get("/api/discover/search?kind=cocktail").await.status,
        StatusCode::BAD_REQUEST
    );

    let l = t
        .get("/api/discover/lookup?source=thecocktaildb&sourceId=11007")
        .await;
    assert_eq!(l.status, StatusCode::OK);
    assert_eq!(l.json["sourceId"], "11007");
    assert_eq!(
        t.get("/api/discover/lookup?source=thecocktaildb&sourceId=404")
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    assert_eq!(
        t.get("/api/discover/lookup?source=thecocktaildb&sourceId=204")
            .await
            .status,
        StatusCode::NOT_FOUND,
        "empty upstream body means not found, not 502"
    );

    // Oversized upstream data is clamped so the imported copy can be saved back.
    let big = t
        .admin(
            Method::POST,
            "/api/discover/import",
            Some(json!({ "source": "thecocktaildb", "sourceId": "777" })),
        )
        .await;
    assert_eq!(big.status, StatusCode::CREATED, "{}", big.json);
    assert_eq!(big.json["ingredients"][0]["amount"], Value::Null);
    let big_id = big.json["id"].as_i64().unwrap();
    let mut edited = big.json.clone();
    edited["versionNote"] = json!("edit imported");
    let saved = t
        .admin(Method::PUT, &format!("/api/recipes/{big_id}"), Some(edited))
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.json);
    assert_eq!(saved.json["source"], "thecocktaildb");
    t.admin(Method::DELETE, &format!("/api/recipes/{big_id}"), None)
        .await;

    // Import: 201 the first time, 200 with the same recipe afterwards.
    let body = json!({ "source": "thecocktaildb", "sourceId": "11007" });
    let unauth = t
        .call(
            Method::POST,
            "/api/discover/import",
            Some(body.clone()),
            false,
        )
        .await;
    assert_eq!(unauth.status, StatusCode::UNAUTHORIZED);
    let first = t
        .admin(Method::POST, "/api/discover/import", Some(body.clone()))
        .await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.json);
    assert_eq!(first.json["source"], "thecocktaildb");
    assert_eq!(first.json["kind"], "cocktail");
    assert_eq!(first.json["tags"], json!(["iba", "cocktail", "alcoholic"]));
    let id = first.json["id"].as_i64().unwrap();
    let second = t
        .admin(Method::POST, "/api/discover/import", Some(body))
        .await;
    assert_eq!(second.status, StatusCode::OK);
    assert_eq!(second.json["id"], id);

    // Lookup now reports the local copy.
    let l = t
        .get("/api/discover/lookup?source=thecocktaildb&sourceId=11007")
        .await;
    assert_eq!(l.json["importedId"], id);
    assert_eq!(t.get("/api/stats").await.json["imported"], 1);
    assert_eq!(
        t.get("/api/recipes?source=imported")
            .await
            .json
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn discover_upstream_down_is_502() {
    let t = setup(false).await;
    let r = t.get("/api/discover/random?kind=cocktail&count=2").await;
    assert_eq!(r.status, StatusCode::BAD_GATEWAY, "{}", r.json);
    assert!(r.json["error"].is_string());
}

#[tokio::test]
async fn discover_disabled_is_503() {
    let t = setup_with(false, &[("DISCOVER_ENABLED", "false")]).await;
    let r = t.get("/api/discover/random?kind=cocktail").await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(r.json["error"].is_string());
    let r = t
        .admin(
            Method::POST,
            "/api/discover/import",
            Some(json!({ "source": "thecocktaildb", "sourceId": "1" })),
        )
        .await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn spa_fallback_and_cache_headers() {
    let dir = TempDir::new().unwrap();
    let static_dir = dir.path().join("static");
    std::fs::create_dir_all(static_dir.join("assets")).unwrap();
    std::fs::write(
        static_dir.join("index.html"),
        "<!doctype html><title>HB</title>",
    )
    .unwrap();
    std::fs::write(static_dir.join("assets/app-abc123.js"), "console.log(1)").unwrap();
    let static_str = static_dir.display().to_string();
    let t = setup_with(false, &[("STATIC_DIR", static_str.as_str())]).await;

    let get = |uri: &'static str| {
        let app = t.app.clone();
        async move {
            app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap()
        }
    };
    let res = get("/assets/app-abc123.js").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        res.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable")
    );

    let res = get("/recipes/42").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-cache");
    assert!(
        res.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );

    let res = get("/").await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-cache");

    let res = get("/assets/missing.js").await;
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-cache");

    // API 404s stay JSON.
    let res = get("/api/missing").await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // Baseline security headers everywhere; no permissive CORS.
    let res = get("/").await;
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    assert_eq!(res.headers()["x-frame-options"], "DENY");
    let res = t
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .header(header::ORIGIN, "https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        res.headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none()
    );
}

/// Hits the real TheCocktailDB. Run with `cargo test -- --ignored`.
#[tokio::test]
#[ignore = "requires internet access"]
async fn live_cocktaildb_random() {
    let t = setup_with(
        false,
        &[
            ("COCKTAILDB_BASE_URL", homebar::config::COCKTAILDB_BASE),
            ("EXTERNAL_TIMEOUT_SECS", "10"),
        ],
    )
    .await;
    let r = t.get("/api/discover/random?kind=cocktail&count=3").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    assert!(!r.json.as_array().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// v2: pantry, availability, settings, catalog, pagination, library sync
// ---------------------------------------------------------------------------

fn total_count(r: &Resp) -> usize {
    r.headers["x-total-count"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap()
}

fn titles(r: &Resp) -> Vec<String> {
    r.json
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["recipe"]["title"].as_str().unwrap().to_owned())
        .collect()
}

async fn pantry_add(t: &TestApp, names: &[&str]) -> Resp {
    t.admin(Method::POST, "/api/pantry", Some(json!({ "names": names })))
        .await
}

#[tokio::test]
async fn pantry_resolves_names_and_requires_admin() {
    let t = setup(false).await;
    let unauth = t
        .call(
            Method::POST,
            "/api/pantry",
            Some(json!({ "names": ["gin"] })),
            false,
        )
        .await;
    assert_eq!(unauth.status, StatusCode::UNAUTHORIZED);

    let r = pantry_add(
        &t,
        &[
            "Лайм",
            "lime",
            "Limes",
            "Lime juice",
            "Сок лайма",
            "  Моя   настойка ",
        ],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    let items = r.json.as_array().unwrap();
    let keys: Vec<&str> = items.iter().map(|i| i["key"].as_str().unwrap()).collect();
    assert_eq!(items.len(), 3, "{keys:?}");
    assert!(keys.contains(&"lime") && keys.contains(&"lime juice"));
    let lime = items.iter().find(|i| i["key"] == "lime").unwrap();
    assert_eq!(lime["name"], "Лайм");
    assert_eq!(lime["nameEn"], "Lime");
    assert_eq!(lime["category"], "fruits");
    assert!(lime["addedAt"].is_string());
    let custom = items.iter().find(|i| i["key"] == "моя настойка").unwrap();
    assert_eq!(custom["name"], "Моя настойка");
    assert_eq!(custom["category"], "other");
    // Sorted by category (juices before fruits before other).
    assert_eq!(keys, vec!["lime juice", "lime", "моя настойка"]);
    assert_eq!(t.get("/api/pantry").await.json.as_array().unwrap().len(), 3);

    // Validation.
    for body in [
        json!({ "names": [] }),
        json!({ "names": ["   "] }),
        json!({ "names": ["x".repeat(81)] }),
        json!({ "names": (0..101).map(|i| format!("n{i}")).collect::<Vec<_>>() }),
        json!({ "nope": 1 }),
    ] {
        let r = t.admin(Method::POST, "/api/pantry", Some(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json);
        assert!(r.json["error"].is_string());
    }

    // Percent-encoded keys with spaces / Cyrillic.
    let unauth = t
        .call(Method::DELETE, "/api/pantry/lime%20juice", None, false)
        .await;
    assert_eq!(unauth.status, StatusCode::UNAUTHORIZED);
    let r = t
        .admin(Method::DELETE, "/api/pantry/lime%20juice", None)
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = t
        .admin(
            Method::DELETE,
            "/api/pantry/%D0%BC%D0%BE%D1%8F%20%D0%BD%D0%B0%D1%81%D1%82%D0%BE%D0%B9%D0%BA%D0%B0",
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let left = t.get("/api/pantry").await.json;
    assert_eq!(left.as_array().unwrap().len(), 1);
    assert_eq!(left[0]["key"], "lime");

    assert_eq!(
        t.call(Method::DELETE, "/api/pantry", None, false)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.admin(Method::DELETE, "/api/pantry", None).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(
        t.get("/api/pantry")
            .await
            .json
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn recipe_ingredients_carry_keys() {
    let t = setup(true).await;
    let list = t.get("/api/recipes?q=Дайкири").await.json;
    let id = list[0]["id"].as_i64().unwrap();
    let r = t.get(&format!("/api/recipes/{id}")).await.json;
    let keys: Vec<&str> = r["ingredients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["light rum", "lime juice", "sugar syrup"]);

    // Keys are resolved on write and never taken from input.
    let mut body = negroni_input();
    body["ingredients"][0]["key"] = json!("hacked");
    let created = t.admin(Method::POST, "/api/recipes", Some(body)).await;
    assert_eq!(created.json["ingredients"][0]["key"], "gin");
    assert_eq!(created.json["ingredients"][2]["key"], "vermouth");
    let cid = created.json["id"].as_i64().unwrap();
    let mut edited = created.json.clone();
    edited["ingredients"][2]["name"] = json!("Красный вермут");
    let saved = t
        .admin(Method::PUT, &format!("/api/recipes/{cid}"), Some(edited))
        .await;
    assert_eq!(saved.json["ingredients"][2]["key"], "sweet vermouth");
    // Version snapshots report keys too.
    let versions = t.get(&format!("/api/recipes/{cid}/versions")).await.json;
    let vid = versions[0]["id"].as_i64().unwrap();
    let v = t
        .get(&format!("/api/recipes/{cid}/versions/{vid}"))
        .await
        .json;
    assert_eq!(v["recipe"]["ingredients"][2]["key"], "vermouth");
}

#[tokio::test]
async fn availability_matching_ordering_and_limits() {
    let t = setup(true).await;

    // Empty pantry: nothing is makeable with maxMissing=0.
    let r = t.get("/api/available").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(total_count(&r), 0);
    assert!(r.json.as_array().unwrap().is_empty());

    // Negroni from RU/EN names; Daiquiri via generic "rum" (parent of light rum).
    pantry_add(
        &t,
        &[
            "gin",
            "Кампари",
            "sweet vermouth",
            "Ром",
            "Lime juice",
            "simple syrup",
        ],
    )
    .await;
    let r = t.get("/api/available?kind=cocktail").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.json);
    let names = titles(&r);
    assert_eq!(total_count(&r), names.len());
    // Favorites (Негрони, Дайкири) come first, then by title.
    assert_eq!(names, vec!["Дайкири", "Негрони"]);
    let first = &r.json[0];
    assert_eq!(first["total"], 3);
    assert!(first["missing"].as_array().unwrap().is_empty());
    assert!(first["recipe"]["ingredientNames"].is_array());

    // maxMissing=2 adds Mojito (missing mint + soda) after the makeable ones.
    let r = t.get("/api/available?kind=cocktail&maxMissing=2").await;
    let names = titles(&r);
    assert_eq!(&names[..2], &["Дайкири", "Негрони"]);
    let counts: Vec<usize> = r
        .json
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["missing"].as_array().unwrap().len())
        .collect();
    assert!(counts.windows(2).all(|w| w[0] <= w[1]), "{counts:?}");
    let mojito = r
        .json
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["recipe"]["title"] == "Мохито")
        .unwrap();
    let missing: Vec<&str> = mojito["missing"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["key"].as_str().unwrap())
        .collect();
    assert_eq!(missing, vec!["mint", "soda water"]);
    assert_eq!(mojito["missing"][0]["name"], "Мята");

    // Pagination + total header.
    let all = t.get("/api/available?maxMissing=5").await;
    let total = total_count(&all);
    assert!(total >= 8, "{total}");
    let page = t.get("/api/available?maxMissing=5&limit=2&offset=1").await;
    assert_eq!(total_count(&page), total);
    assert_eq!(titles(&page), titles(&all)[1..3].to_vec());
    // Filters.
    let dishes = t.get("/api/available?kind=dish&maxMissing=5").await;
    assert!(
        dishes
            .json
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["recipe"]["kind"] == "dish")
    );
    let q = t.get("/api/available?maxMissing=5&q=негр").await;
    assert_eq!(titles(&q), vec!["Негрони"]);
    let tag = t.get("/api/available?maxMissing=5&tag=Ром").await;
    assert_eq!(total_count(&tag), 2);
    for bad in [
        "maxMissing=6",
        "maxMissing=-1",
        "maxMissing=x",
        "limit=0",
        "limit=201",
        "offset=-1",
        "kind=drink",
    ] {
        let r = t.get(&format!("/api/available?{bad}")).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }

    // Staples never count; generic pantry item satisfies a specific recipe item
    // and vice versa, but siblings do not.
    let body = json!({
        "title": "Staples test", "kind": "cocktail",
        "ingredients": [
            { "name": "Light rum" }, { "name": "Лёд" }, { "name": "Вода" },
            { "name": "boiling water" }
        ]
    });
    t.admin(Method::POST, "/api/recipes", Some(body)).await;
    let body = json!({
        "title": "Dark test", "kind": "cocktail",
        "ingredients": [{ "name": "Тёмный ром" }]
    });
    t.admin(Method::POST, "/api/recipes", Some(body)).await;
    t.admin(Method::DELETE, "/api/pantry", None).await;
    pantry_add(&t, &["Белый ром"]).await;
    let r = t.get("/api/available?q=test").await;
    assert_eq!(titles(&r), vec!["Staples test"]);
    assert_eq!(r.json[0]["total"], 1);
    let body = json!({
        "title": "Generic test", "kind": "cocktail",
        "ingredients": [{ "name": "Rum" }]
    });
    t.admin(Method::POST, "/api/recipes", Some(body)).await;
    let r = t.get("/api/available?q=test").await;
    assert_eq!(titles(&r), vec!["Generic test", "Staples test"]);
}

#[tokio::test]
async fn pantry_suggestions_count_unlocks() {
    let t = setup(true).await;
    assert!(
        t.get("/api/pantry/suggestions")
            .await
            .json
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["unlocks"].as_u64().unwrap() >= 1)
    );
    pantry_add(&t, &["Джин", "Кампари", "Белый ром", "Сок лайма"]).await;
    let r = t.get("/api/pantry/suggestions?kind=cocktail").await;
    assert_eq!(r.status, StatusCode::OK);
    let list = r.json.as_array().unwrap();
    let by_key = |k: &str| list.iter().find(|s| s["key"] == k).cloned();
    // Sugar syrup unlocks Daiquiri; sweet vermouth unlocks Negroni.
    let syrup = by_key("sugar syrup").expect("sugar syrup suggested");
    assert_eq!(syrup["unlocks"], 1);
    assert_eq!(syrup["name"], "Сахарный сироп");
    assert_eq!(syrup["category"], "syrups");
    assert_eq!(by_key("sweet vermouth").unwrap()["unlocks"], 1);
    assert!(by_key("mint").is_none(), "mojito needs 3 more things");
    let unlocks: Vec<u64> = list
        .iter()
        .map(|s| s["unlocks"].as_u64().unwrap())
        .collect();
    assert!(unlocks.windows(2).all(|w| w[0] >= w[1]));
    let dishes = t.get("/api/pantry/suggestions?kind=dish").await.json;
    assert!(
        dishes
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["key"] != "sugar syrup")
    );
    assert_eq!(
        t.get("/api/pantry/suggestions?limit=1")
            .await
            .json
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        t.get("/api/pantry/suggestions?limit=0").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn settings_defaults_validation_and_auth() {
    let t = setup(false).await;
    let r = t.get("/api/settings").await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.json,
        json!({ "guestMaxMissing": 0, "guestShowMenu": true })
    );
    let body = json!({ "guestMaxMissing": 2, "guestShowMenu": false });
    let unauth = t
        .call(Method::PUT, "/api/settings", Some(body.clone()), false)
        .await;
    assert_eq!(unauth.status, StatusCode::UNAUTHORIZED);
    for bad in [
        json!({ "guestMaxMissing": 4, "guestShowMenu": true }),
        json!({ "guestMaxMissing": -1, "guestShowMenu": true }),
        json!({ "guestShowMenu": true }),
        json!({ "guestMaxMissing": 1, "guestShowMenu": "yes" }),
    ] {
        let r = t.admin(Method::PUT, "/api/settings", Some(bad)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json);
    }
    let r = t
        .admin(Method::PUT, "/api/settings", Some(body.clone()))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json, body);
    assert_eq!(t.get("/api/settings").await.json, body);
}

#[tokio::test]
async fn menu_items_report_missing() {
    let t = setup(true).await;
    let menu = t.get("/api/menus/active").await.json;
    let negroni = |m: &Value| {
        m["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["recipe"]["title"] == "Негрони")
            .cloned()
            .unwrap()
    };
    assert_eq!(negroni(&menu)["missing"].as_array().unwrap().len(), 3);
    assert_eq!(negroni(&menu)["missing"][0]["key"], "gin");
    assert_eq!(negroni(&menu)["missing"][0]["name"], "Джин");
    pantry_add(&t, &["Gin", "Campari", "Rosso vermouth"]).await;
    let menu = t.get("/api/menus/active").await.json;
    assert!(negroni(&menu)["missing"].as_array().unwrap().is_empty());
    let id = menu["id"].as_i64().unwrap();
    let by_id = t.get(&format!("/api/menus/{id}")).await.json;
    assert!(negroni(&by_id)["missing"].as_array().unwrap().is_empty());
    assert!(
        by_id["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["missing"].is_array())
    );
}

#[tokio::test]
async fn ingredient_catalog_autocomplete() {
    let t = setup(true).await;
    pantry_add(&t, &["Лайм"]).await;
    let r = t.get("/api/ingredients?q=лайм").await;
    assert_eq!(r.status, StatusCode::OK);
    let list = r.json.as_array().unwrap();
    assert!(!list.is_empty() && list.len() <= 20);
    // Exact match first, then prefix/substring matches ranked by usage.
    assert_eq!(list[0]["key"], "lime");
    assert_eq!(list[0]["name"], "Лайм");
    assert_eq!(list[0]["nameEn"], "Lime");
    assert_eq!(list[0]["inPantry"], true);
    let juice = list.iter().find(|i| i["key"] == "lime juice").unwrap();
    assert_eq!(juice["recipeCount"], 4);
    assert_eq!(juice["inPantry"], false);
    assert_eq!(juice["category"], "juices");

    // English and alias search.
    let r = t.get("/api/ingredients?q=Light%20rum&limit=5").await;
    assert_eq!(r.json[0]["key"], "light rum");
    assert!(r.json.as_array().unwrap().len() <= 5);
    let r = t.get("/api/ingredients?q=светлый%20ром").await;
    assert_eq!(r.json[0]["key"], "light rum");

    // Empty q: most used first.
    let r = t.get("/api/ingredients").await.json;
    let counts: Vec<i64> = r
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["recipeCount"].as_i64().unwrap())
        .collect();
    assert!(counts.windows(2).all(|w| w[0] >= w[1]), "{counts:?}");
    assert_eq!(r[0]["recipeCount"], 4);

    // Custom keys used by local recipes are included.
    let body = json!({
        "title": "Custom", "kind": "other",
        "ingredients": [{ "name": "Секретный ингредиент" }]
    });
    t.admin(Method::POST, "/api/recipes", Some(body)).await;
    let r = t.get("/api/ingredients?q=секрет").await.json;
    assert_eq!(r[0]["key"], "секретный ингредиент");
    assert_eq!(r[0]["name"], "Секретный ингредиент");
    assert_eq!(r[0]["recipeCount"], 1);
    assert_eq!(
        t.get("/api/ingredients?limit=0").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn recipes_limit_offset_and_total_header() {
    let t = setup(true).await;
    let all = t.get("/api/recipes").await;
    let n = all.json.as_array().unwrap().len();
    assert_eq!(total_count(&all), n);
    let page = t.get("/api/recipes?limit=3&offset=2").await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(total_count(&page), n);
    assert_eq!(
        page.json.as_array().unwrap()[..],
        all.json.as_array().unwrap()[2..5]
    );
    let tail = t
        .get(&format!("/api/recipes?limit=200&offset={}", n - 1))
        .await;
    assert_eq!(tail.json.as_array().unwrap().len(), 1);
    let filtered = t.get("/api/recipes?kind=dish&limit=1").await;
    assert_eq!(total_count(&filtered), 2);
    assert_eq!(filtered.json.as_array().unwrap().len(), 1);
    for bad in ["limit=0", "limit=201", "limit=abc", "offset=-3"] {
        assert_eq!(
            t.get(&format!("/api/recipes?{bad}")).await.status,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
}

#[tokio::test]
async fn availability_is_fast_on_large_library() {
    let t = setup(false).await;
    let cat = homebar::catalog::catalog();
    let names: Vec<&str> = cat
        .entries()
        .iter()
        .take(300)
        .map(|e| e.name_en.as_str())
        .collect();
    let mut tx = t.pool.begin().await.unwrap();
    for r in 0..1500usize {
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO recipes (title, kind, created_at, updated_at)
             VALUES (?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z') RETURNING id",
        )
        .bind(format!("Synthetic {r}"))
        .bind(if r % 2 == 0 { "cocktail" } else { "dish" })
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        for p in 0..10usize {
            let name = names[(r * 7 + p * 13) % names.len()];
            sqlx::query(
                "INSERT INTO recipe_ingredients (recipe_id, position, name, ingredient_key)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(p as i64)
            .bind(name)
            .bind(cat.resolve(name))
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO recipe_tags (recipe_id, position, tag) VALUES (?, 0, 'synthetic')",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let pantry: Vec<&str> = names.iter().step_by(4).copied().collect();
    pantry_add(&t, &pantry).await;

    // Warm up, then measure.
    t.get("/api/available?maxMissing=5").await;
    let runs = 5;
    let started = std::time::Instant::now();
    let mut total = 0;
    for _ in 0..runs {
        let r = t.get("/api/available?maxMissing=5&limit=60").await;
        assert_eq!(r.status, StatusCode::OK);
        total = total_count(&r);
    }
    let per_request = started.elapsed() / runs;
    eprintln!("availability over 1500 recipes x 10 ingredients: {per_request:?} ({total} matches)");
    assert!(total > 0);
    let budget = if cfg!(debug_assertions) { 500 } else { 50 };
    assert!(
        per_request < std::time::Duration::from_millis(budget),
        "{per_request:?}"
    );
}

// --- Library sync against local mock upstreams ------------------------------

fn meal(id: u32) -> Value {
    json!({
        "idMeal": id.to_string(), "strMeal": format!("Meal {id}"), "strCategory": "Beef",
        "strArea": "British", "strInstructions": "Cook.", "strMealThumb": null,
        "strIngredient1": "Onions", "strMeasure1": "2",
        "strIngredient2": "Beef", "strMeasure2": "500g",
        "strIngredient3": "Water", "strMeasure3": "1 cup"
    })
}

#[derive(Default)]
struct MockStats {
    in_flight: std::sync::atomic::AtomicUsize,
    max_in_flight: std::sync::atomic::AtomicUsize,
    requests: std::sync::atomic::AtomicUsize,
    failed_once: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl MockStats {
    /// Tracks concurrency; returns true the first time `key` is seen when it
    /// should fail (to exercise retries).
    async fn enter(&self, fail_key: Option<String>) -> (bool, Guard<'_>) {
        use std::sync::atomic::Ordering;
        self.requests.fetch_add(1, Ordering::SeqCst);
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
        let fail = fail_key.is_some_and(|k| self.failed_once.lock().unwrap().insert(k));
        (fail, Guard(self))
    }
}

struct Guard<'a>(&'a MockStats);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0
            .in_flight
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

async fn serve_mock(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}/")
}

/// TheMealDB look-alike: letters a/b/c have meals (b repeats one of a; c fails
/// once with 500).
async fn mock_mealdb(stats: std::sync::Arc<MockStats>) -> String {
    use axum::extract::Query;
    use axum::response::IntoResponse;
    use axum::routing::get;
    let app = Router::new().route(
        "/search.php",
        get(move |Query(q): Query<HashMap<String, String>>| {
            let stats = stats.clone();
            async move {
                let f = q.get("f").cloned().unwrap_or_default();
                let fail_key = (f == "c").then(|| "meal-c".to_owned());
                let (fail, _g) = stats.enter(fail_key).await;
                if fail {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
                let meals = match f.as_str() {
                    "a" => json!([meal(1), meal(2)]),
                    "b" => json!([meal(2), meal(3)]),
                    "c" => json!([meal(4)]),
                    _ => Value::Null,
                };
                axum::Json(json!({ "meals": meals })).into_response()
            }
        }),
    );
    serve_mock(app).await
}

/// TheCocktailDB look-alike with list/filter/lookup; lookup of 14 is rate
/// limited once (429).
async fn mock_cocktaildb(stats: std::sync::Arc<MockStats>) -> String {
    use axum::extract::Query;
    use axum::response::IntoResponse;
    use axum::routing::get;
    let ids = |list: &[u32]| {
        json!({ "drinks": list.iter().map(|i| json!({
            "idDrink": i.to_string(), "strDrink": format!("Drink {i}"), "strDrinkThumb": null
        })).collect::<Vec<_>>() })
    };
    let s1 = stats.clone();
    let s2 = stats.clone();
    let s3 = stats;
    let app = Router::new()
        .route(
            "/list.php",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let stats = s1.clone();
                async move {
                    let _g = stats.enter(None).await;
                    if q.contains_key("c") {
                        axum::Json(json!({ "drinks": [{ "strCategory": "Cocktail" }] }))
                    } else if q.contains_key("g") {
                        axum::Json(json!({ "drinks": [{ "strGlass": "Coupe" }] }))
                    } else {
                        axum::Json(json!({ "drinks": [{ "strIngredient1": "Gin" }] }))
                    }
                }
            }),
        )
        .route(
            "/filter.php",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let stats = s2.clone();
                async move {
                    let _g = stats.enter(None).await;
                    let (k, v) = q.into_iter().next().unwrap_or_default();
                    match (k.as_str(), v.to_lowercase().as_str()) {
                        ("c", "cocktail") => axum::Json(ids(&[11, 12])),
                        ("a", "alcoholic") => axum::Json(ids(&[12, 13])),
                        ("g", "coupe") => axum::Json(ids(&[13])),
                        ("i", "gin") => axum::Json(ids(&[11, 14])),
                        _ => axum::Json(json!({ "drinks": "None Found" })),
                    }
                }
            }),
        )
        .route(
            "/lookup.php",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let stats = s3.clone();
                async move {
                    let id = q.get("i").cloned().unwrap_or_default();
                    let fail_key = (id == "14").then(|| "lookup-14".to_owned());
                    let (fail, _g) = stats.enter(fail_key).await;
                    if fail {
                        return StatusCode::TOO_MANY_REQUESTS.into_response();
                    }
                    axum::Json(json!({ "drinks": [drink(&id, &format!("Drink {id}"))] }))
                        .into_response()
                }
            }),
        );
    serve_mock(app).await
}

async fn wait_for_sync(t: &TestApp) -> Value {
    for _ in 0..600 {
        let s = t.get("/api/library/sync").await.json;
        if s["running"] == false {
            return s;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("library sync did not finish");
}

#[tokio::test]
async fn library_sync_with_mock_upstreams() {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    let meal_stats = Arc::new(MockStats::default());
    let drink_stats = Arc::new(MockStats::default());
    let mealdb = mock_mealdb(meal_stats.clone()).await;
    let cocktaildb = mock_cocktaildb(drink_stats.clone()).await;
    let t = setup_with(
        false,
        &[
            ("MEALDB_BASE_URL", mealdb.as_str()),
            ("COCKTAILDB_BASE_URL", cocktaildb.as_str()),
            ("LIBRARY_SYNC_DELAY_MS", "2"),
            ("LIBRARY_SYNC_BACKOFF_MS", "10"),
        ],
    )
    .await;

    let idle = t.get("/api/library/sync").await;
    assert_eq!(idle.status, StatusCode::OK);
    assert_eq!(idle.json["running"], false);
    assert_eq!(idle.json["source"], Value::Null);
    assert_eq!(idle.json["startedAt"], Value::Null);

    // Drink 11 is already imported: must be skipped, not duplicated.
    let pre = t
        .admin(
            Method::POST,
            "/api/discover/import",
            Some(json!({ "source": "thecocktaildb", "sourceId": "11" })),
        )
        .await;
    assert_eq!(pre.status, StatusCode::CREATED);

    let body = json!({ "sources": ["themealdb", "thecocktaildb", "themealdb"] });
    assert_eq!(
        t.call(Method::POST, "/api/library/sync", Some(body.clone()), false)
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    for bad in [
        json!({ "sources": [] }),
        json!({ "sources": ["own"] }),
        json!({ "sources": ["nope"] }),
        json!({}),
    ] {
        let r = t.admin(Method::POST, "/api/library/sync", Some(bad)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.json);
    }

    let started = t
        .admin(Method::POST, "/api/library/sync", Some(body.clone()))
        .await;
    assert_eq!(started.status, StatusCode::ACCEPTED, "{}", started.json);
    assert_eq!(started.json["running"], true);
    assert_eq!(started.json["source"], "themealdb");
    assert!(started.json["startedAt"].is_string());
    let again = t
        .admin(Method::POST, "/api/library/sync", Some(body.clone()))
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert!(again.json["error"].is_string());

    let done = wait_for_sync(&t).await;
    assert_eq!(done["running"], false);
    assert_eq!(done["source"], "thecocktaildb");
    // Meals 1-4 (one duplicate across letters, letter c retried after a 500),
    // drinks 12, 13, 14 (14 retried after a 429); drink 11 skipped.
    assert_eq!(done["imported"], 7, "{done}");
    assert_eq!(done["skipped"], 1, "{done}");
    assert_eq!(done["failed"], 0, "{done}");
    assert_eq!(done["total"], 4, "drink ids 11-14 in the cocktail phase");
    assert_eq!(done["done"], 4);
    assert!(done["finishedAt"].is_string());
    assert!(meal_stats.max_in_flight.load(Ordering::SeqCst) <= 4);
    assert!(drink_stats.max_in_flight.load(Ordering::SeqCst) <= 4);
    assert!(
        drink_stats.max_in_flight.load(Ordering::SeqCst) >= 2,
        "requests run in parallel"
    );

    let stats = t.get("/api/stats").await.json;
    assert_eq!(stats["imported"], 8);
    assert_eq!(stats["dishes"], 4);
    assert_eq!(stats["cocktails"], 4);
    let meals = t.get("/api/recipes?kind=dish").await.json;
    let m = &meals[0];
    assert_eq!(m["favorite"], false);
    let full = t
        .get(&format!("/api/recipes/{}", m["id"].as_i64().unwrap()))
        .await
        .json;
    let keys: Vec<&str> = full["ingredients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["onion", "beef", "water"]);
    assert_eq!(full["source"], "themealdb");

    // A second run imports nothing new.
    let r = t.admin(Method::POST, "/api/library/sync", Some(body)).await;
    assert_eq!(r.status, StatusCode::ACCEPTED);
    let second = wait_for_sync(&t).await;
    assert_eq!(second["imported"], 0, "{second}");
    assert_eq!(second["skipped"], 8, "{second}");
    assert_eq!(t.get("/api/stats").await.json["imported"], 8);
}

#[tokio::test]
async fn library_sync_disabled_offline() {
    let t = setup_with(false, &[("DISCOVER_ENABLED", "false")]).await;
    let r = t
        .admin(
            Method::POST,
            "/api/library/sync",
            Some(json!({ "sources": ["themealdb"] })),
        )
        .await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
}
