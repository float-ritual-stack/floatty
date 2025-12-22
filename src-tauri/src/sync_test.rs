#[cfg(test)]
mod tests {
    use yrs::{Doc, StateVector, Update, Transact, Text, ReadTxn, GetString};

    #[test]
    fn test_yrs_setup() {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("content");
        
        {
            let mut txn = doc.transact_mut();
            text.push(&mut txn, "Hello from Rust!");
        }

        let content = text.get_string(&doc.transact());
        assert_eq!(content, "Hello from Rust!");
    }
}
