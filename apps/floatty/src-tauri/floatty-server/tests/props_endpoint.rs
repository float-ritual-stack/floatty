//! Router contract: short IDs, guarded writes, rejection, and canonical ancestor context.
use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use floatty_core::{HookSystem, YDocStore};
use floatty_server::{api::create_router, WsBroadcaster};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;
use yrs::{Map, Transact, WriteTxn};

async fn post(app: &Router, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)})),
    )
}

#[tokio::test]
async fn props_route_contract() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(YDocStore::open(&dir.path().join("test.db"), "test").unwrap());
    let hooks = Arc::new(HookSystem::initialize_at(store.clone(), None));
    let parent = "demo-board";
    let child = "00000000-0000-4000-8000-000000000002";
    {
        let doc = store.doc();
        let guard = doc.write().unwrap();
        let mut txn = guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let p: yrs::MapRef = blocks.get_or_init(&mut txn, parent);
        p.insert(&mut txn, "content", "Demo board");
        let c: yrs::MapRef = blocks.get_or_init(&mut txn, child);
        c.insert(&mut txn, "content", "[[⬜]] card");
        c.insert(&mut txn, "parentId", parent);
        c.insert(&mut txn, "updatedAt", 42_f64);
    }
    let app = create_router(store, Arc::new(WsBroadcaster::new(16)), hooks, None);
    // A unique eight-digit prefix resolves to the canonical UUID.
    let path = format!("/api/v1/blocks/{}/props", &child[..8]);
    let (status, body) = post(
        &app,
        &path,
        json!({"set":{"status":"doing","project":"demo"},"ifUpdatedAt":42}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], child);
    assert_eq!(body["content"], "[[🟨]] card [project::demo]");
    assert_eq!(body["ancestorContext"]["ancestorBlockIds"], json!([parent]));
    let (status, body) = post(
        &app,
        &path,
        json!({"expect":{"status":"todo"},"set":{"status":"done"}}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["current"]["status"], "doing");
    assert!(body["updatedAt"].is_i64());
    let (status, body) = post(&app, &path, json!({"set":{"project":"bad]value"}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["key"], "project");
    assert_eq!(body["value"], "bad]value");
    assert_eq!(body["reason"], "unrepresentableValue");
    let (status, body) = post(&app, &path, json!({"unset":["status","project"]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["content"], "card");
    assert_eq!(body["ancestorContext"]["ancestorBlockIds"], json!([parent]));
    let (status, _) = post(&app, &path, json!({"if_updated_at":42})).await;
    assert!(status.is_client_error());
    let (status, _) = post(
        &app,
        "/api/v1/blocks/missing/props",
        json!({"set":{"status":"done"}}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
