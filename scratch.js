const express = require('express');
const cookieSession = require('cookie-session');

const app = express();
app.use(cookieSession({
  name: 'session',
  secret: 'my-secret',
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

app.get('/', (req, res) => {
  req.session.views = (req.session.views || 0) + 1;
  res.send(req.session.views + ' views');
});

app.listen(3001, () => console.log('started on 3001'));
