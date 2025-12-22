#[cfg(test)]
mod tests {
    use crate::db::{CtxDatabase, Block, BlockType};
    use std::sync::Arc;

    #[test]
    fn test_blocks_table_schema() {
        // This test expects the database to have a 'blocks' table.
        // It will fail until we update db.rs to create it.
        
        // Use an in-memory database for testing
        let db = CtxDatabase::open_in_memory().expect("Failed to open in-memory DB");
        
        // Attempt to insert a block - this should fail if the table doesn't exist
        let block = Block {
            id: "test-block-1".to_string(),
            content: "Hello World".to_string(),
            parent_id: None,
            type_: BlockType::Text,
            collapsed: false,
            created_at: 1234567890,
            updated_at: 1234567890,
        };

        let result = db.insert_block(&block);
        assert!(result.is_ok(), "Failed to insert block: {:?}", result.err());
        
        // Verify we can read it back
        let retrieved = db.get_block("test-block-1").expect("Failed to get block");
        assert_eq!(retrieved.content, "Hello World");
    }
}
