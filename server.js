require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

const { LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, REDIRECT_URI, PORT } = process.env;
const SCOPES = 'openid profile email w_member_social';
const LINKEDIN_HEADERS = {
  'Content-Type': 'application/json',
  'X-Restli-Protocol-Version': '2.0.0',
  'LinkedIn-Version': '202604',
};

// Step 1: Redirect user to LinkedIn OAuth
app.get('/auth/linkedin', (req, res) => {
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`;
  res.redirect(authUrl);
});

// Step 2: LinkedIn redirects back with code
app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${error}`);

  try {
    const tokenRes = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
      params: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    req.session.accessToken = tokenRes.data.access_token;

    const profileRes = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${req.session.accessToken}` },
    });

    req.session.userSub = profileRes.data.sub;
    req.session.userName = profileRes.data.name;

    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  res.sendFile(__dirname + '/public/dashboard.html');
});

// API: Get current user info
app.get('/api/me', (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ name: req.session.userName, sub: req.session.userSub });
});

// API: Create a post (personal or company page)
app.post('/api/post', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const { text, postAs } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Post text is required' });

  const authorUrn = postAs === 'company'
    ? `urn:li:organization:${process.env.LINKEDIN_COMPANY_ID}`
    : `urn:li:person:${req.session.userSub}`;

  try {
    const response = await axios.post(
      'https://api.linkedin.com/rest/posts',
      {
        author: authorUrn,
        commentary: text.trim(),
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
      {
        headers: {
          Authorization: `Bearer ${req.session.accessToken}`,
          ...LINKEDIN_HEADERS,
        },
      }
    );

    const postId = response.headers['x-restli-id'] || response.data.id;
    req.session.lastPostId = postId;

    const postedAs = postAs === 'company' ? 'Tecofize Company Page' : 'Personal Profile';
    res.json({ success: true, postId, postedAs });
  } catch (err) {
    console.error('Post error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// API: Get a post by ID
app.get('/api/post/:postId', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const postId = decodeURIComponent(req.params.postId);

  try {
    const response = await axios.get(
      `https://api.linkedin.com/rest/posts/${encodeURIComponent(postId)}`,
      {
        headers: {
          Authorization: `Bearer ${req.session.accessToken}`,
          ...LINKEDIN_HEADERS,
        },
      }
    );

    res.json({ success: true, post: response.data });
  } catch (err) {
    console.error('Get post error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// API: Delete a post
app.delete('/api/post/:postId', async (req, res) => {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });

  const postId = decodeURIComponent(req.params.postId);

  try {
    await axios.delete(`https://api.linkedin.com/rest/posts/${encodeURIComponent(postId)}`, {
      headers: {
        Authorization: `Bearer ${req.session.accessToken}`,
        ...LINKEDIN_HEADERS,
      },
    });

    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
