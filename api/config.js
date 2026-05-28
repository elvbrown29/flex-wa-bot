module.exports = (req, res) => {
    // Set headers to allow safe dynamic fetches
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Return the backend URL configured securely in the Vercel dashboard
    res.status(200).json({
        backendUrl: process.env.BACKEND_URL || ''
    });
};
