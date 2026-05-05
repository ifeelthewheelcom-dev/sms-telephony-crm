require('dotenv').config({ path: '../.env' });
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post('/test', (req, res) => {
  console.log("Body:", req.body);
  console.log("Query:", req.query);
  res.send('ok');
});

app.listen(8149, () => {
  console.log("Listening on 8149");
});
