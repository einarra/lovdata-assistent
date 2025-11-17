// Simple test function to verify Vercel recognizes functions in /api
export default function handler(req, res) {
  res.status(200).json({ 
    message: 'API function is working!',
    path: req.url,
    method: req.method
  });
}

