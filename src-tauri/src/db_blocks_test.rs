#[cfg(test)]
mod tests {
    use crate::db::{CtxDatabase, Block, BlockType};
    use std::sync::Arc;

    #[test]
    fn test_blocks_crud() {
        let db = CtxDatabase::open_in_memory().expect("Failed to open in-memory DB");
        
        let block_id = "test-block-crud";
        let block = Block {
            id: block_id.to_string(),
            content: "Initial Content".to_string(),
            parent_id: None,
            type_: BlockType::Text,
            collapsed: false,
            created_at: 100,
            updated_at: 100,
        };

        // Insert
        db.insert_block(&block).expect("Insert failed");

        // Update
        let mut updated_block = block.clone();
        updated_block.content = "Updated Content".to_string();
        updated_block.updated_at = 200;
        db.update_block(&updated_block).expect("Update failed");

        let retrieved = db.get_block(block_id).expect("Get failed");
        assert_eq!(retrieved.content, "Updated Content");
        assert_eq!(retrieved.updated_at, 200);

        // Delete (not implemented yet, but let's test if we add it)
        // db.delete_block(block_id).expect("Delete failed");
        // assert!(db.get_block(block_id).is_err());
    }

    #[test]
    fn test_block_children() {
        let db = CtxDatabase::open_in_memory().expect("Failed to open DB");
        
        let parent = Block {
            id: "parent".to_string(),
            content: "Parent".to_string(),
            parent_id: None,
            type_: BlockType::Text,
            collapsed: false,
            created_at: 1,
            updated_at: 1,
        };
        db.insert_block(&parent).unwrap();

        let child1 = Block {
            id: "child1".to_string(),
            content: "Child 1".to_string(),
            parent_id: Some("parent".to_string()),
            type_: BlockType::Text,
            collapsed: false,
            created_at: 2,
            updated_at: 2,
        };
        db.insert_block(&child1).unwrap();

        let child2 = Block {
            id: "child2".to_string(),
            content: "Child 2".to_string(),
            parent_id: Some("parent".to_string()),
            type_: BlockType::Text,
            collapsed: false,
            created_at: 3,
            updated_at: 3,
        };
        db.insert_block(&child2).unwrap();

        let children = db.get_children("parent").expect("Failed to get children");
        assert_eq!(children.len(), 2);
        // Ordering check? We didn't add an 'order' column yet.
        // For now just check existence.
        assert!(children.iter().any(|b| b.id == "child1"));
        assert!(children.iter().any(|b| b.id == "child2"));
    }
}