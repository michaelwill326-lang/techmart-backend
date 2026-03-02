const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./ecommerce.db");

db.serialize(() => {
  db.run("DELETE FROM products");

  const stmt = db.prepare(
    "INSERT INTO products (name, price, image) VALUES (?, ?, ?)"
  );

  stmt.run(
    "Gaming Laptop",
    1200,
    "https://via.placeholder.com/300x200?text=Laptop"
  );

  stmt.run(
    "Wireless Headphones",
    150,
    "https://via.placeholder.com/300x200?text=Headphones"
  );

  stmt.run(
    "Mechanical Keyboard",
    90,
    "https://via.placeholder.com/300x200?text=Keyboard"
  );

  stmt.finalize();

  console.log("✅ Products seeded successfully");
});

db.close();
