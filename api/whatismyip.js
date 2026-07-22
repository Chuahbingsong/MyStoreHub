export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const response = await fetch('https://api.ipify.org?format=json');
  const data = await response.json();

  console.log('[whatismyip] outbound_ip:', data.ip);

  return res.status(200).json({ outbound_ip: data.ip });
}
