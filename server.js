const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const VOE_REFERER = "https://voe.sx/";

// Security Key (Hugging Face Secret se ya default)
const MASTER_SECRET_KEY = process.env.MASTER_SECRET_KEY || 'MaxPlayMasterPass777!';

app.get('/api/extract', async (req, res) => {
    // 1. Security Check: Header ya query se secret key match honi chahiye
    const clientSecret = req.headers['x-maxplay-secret'] || req.query.key;
    if (clientSecret !== MASTER_SECRET_KEY) {
        return res.status(403).json({ error: 'Access Denied: Invalid or Missing Secret Key' });
    }

    const targetUrl = req.query.url;

    if (!targetUrl || !targetUrl.includes('voe.sx')) {
        return res.status(400).json({ error: 'Valid Voe.sx URL is required' });
    }

    let browser;
    try {
        console.log(`[INFO] Fast Extraction started for: ${targetUrl}`);
        
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--no-first-run',
                '--no-zygote',
                '--disable-blink-features=AutomationControlled'
            ],
        });

        const page = await browser.newPage();
        const urlObj = new URL(targetUrl);
        const origin = `${urlObj.protocol}//${urlObj.host}`;
        
        await page.setUserAgent(USER_AGENT);

        let m3u8Url = null;

        // 🔥 1. SPEED BOOST: Unwanted resource blocking (images, stylesheets, fonts, media)
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const reqUrl = request.url();
            const resourceType = request.resourceType();

            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                request.abort();
                return;
            }

            if (reqUrl.includes('.m3u8')) {
                if (!reqUrl.includes('ping.gif') && !reqUrl.includes('jwpltx.com')) {
                    if (!m3u8Url) {
                        m3u8Url = reqUrl;
                        console.log(`[SUCCESS] Fast Intercepted Direct M3U8: ${reqUrl}`);
                    }
                } else if (reqUrl.includes('mu=')) {
                    try {
                        const urlParams = new URL(reqUrl).searchParams;
                        const mu = urlParams.get('mu');
                        if (mu && mu.includes('.m3u8') && !m3u8Url) {
                            m3u8Url = decodeURIComponent(mu);
                            console.log(`[SUCCESS] Fast Extracted M3U8 from Tracking Ping: ${m3u8Url}`);
                        }
                    } catch (e) {
                        console.error("Error parsing ping URL:", e.message);
                    }
                }
            }
            request.continue();
        });

        // 🔥 2. Fast Navigation (domcontentloaded - heavy load ka wait nahi karna padega)
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        await page.evaluate(() => {
            const clickPlay = () => {
                const playBtn = document.querySelector('.play-btn') || 
                                document.querySelector('#play-btn') || 
                                document.querySelector('.play-wrapper') ||
                                document.querySelector('video') ||
                                document.querySelector('button');
                if (playBtn) playBtn.click();
                else document.body.click();
            };
            clickPlay();
            const interval = setInterval(clickPlay, 200);
            setTimeout(() => clearInterval(interval), 2000);
        });

        // 🔥 3. Quick Check Loop (100ms interval, max 6 seconds tak wait)
        let attempts = 0;
        while (!m3u8Url && attempts < 60) {
            await delay(100);
            attempts++;
        }

        await browser.close();

        if (m3u8Url) {
            const serverHost = 'https://' + req.get('host');
            const proxiedM3u8 = `${serverHost}/proxy/m3u8?url=${encodeURIComponent(m3u8Url)}`;

            return res.status(200).json({
                rawVoeUrl: m3u8Url,
                m3u8Url: proxiedM3u8,
                headers: {
                    "Referer": origin + "/",
                    "Origin": origin,
                    "User-Agent": USER_AGENT
                }
            });
        } else {
            return res.status(404).json({ error: 'M3U8 link not found quickly' });
        }

    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        if (browser) await browser.close();
        return res.status(500).json({ error: 'Extraction failed', details: error.message });
    }
});

app.get('/proxy/m3u8', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Missing M3U8 URL");

    try {
        console.log(`[PROXY M3U8] Fetching: ${targetUrl}`);
        const response = await fetch(targetUrl, {
            headers: { 'Referer': VOE_REFERER, 'User-Agent': USER_AGENT }
        });
        
        if (!response.ok) {
            console.error(`[PROXY M3U8 ERROR] Upstream status: ${response.status}`);
            return res.status(response.status).send(`Upstream Error: ${response.statusText}`);
        }
        
        let text = await response.text();
        const serverHost = 'https://' + req.get('host');
        
        const parsedTargetUrl = new URL(targetUrl);
        const basePath = parsedTargetUrl.pathname.substring(0, parsedTargetUrl.pathname.lastIndexOf('/') + 1);
        const baseUrl = `${parsedTargetUrl.origin}${basePath}`;
        
        const lines = text.split('\n');
        const rewrittenLines = lines.map(line => {
            line = line.trim();
            if (!line) return '';
            
            // 🔥 Master playlist ke andar audio/subtitle tracks (#EXT-X-MEDIA:...,URI="...") ko handle karna
            if (line.startsWith('#')) {
                if (line.includes('URI="')) {
                    return line.replace(/URI="([^"]+)"/, (match, uri) => {
                        let fullUri = uri.startsWith('http') ? uri : baseUrl + uri;
                        return `URI="${serverHost}/proxy/m3u8?url=${encodeURIComponent(fullUri)}"`;
                    });
                }
                return line;
            }
            
            let fullUrl = line.startsWith('http') ? line : baseUrl + line;
            
            if (fullUrl.includes('.m3u8')) {
                return `${serverHost}/proxy/m3u8?url=${encodeURIComponent(fullUrl)}`;
            } else {
                return `${serverHost}/proxy/ts?url=${encodeURIComponent(fullUrl)}`;
            }
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenLines.join('\n'));
    } catch (err) {
        console.error("M3U8 Proxy Exception:", err.message);
        res.status(500).send("M3U8 Proxy Error");
    }
});

app.get('/proxy/ts', async (req, res) => {
    const chunkUrl = req.query.url;
    if (!chunkUrl) return res.status(400).send("Missing TS Chunk URL");

    try {
        const fetchHeaders = { 
            'Referer': VOE_REFERER, 
            'User-Agent': USER_AGENT 
        };
        
        if (req.headers.range) {
            fetchHeaders['Range'] = req.headers.range;
        }

        const response = await fetch(chunkUrl, {
            headers: fetchHeaders
        });

        if (!response.ok && response.status !== 206) {
            console.error(`[CHUNK ERROR] Status: ${response.status} for URL: ${chunkUrl}`);
            return res.status(response.status).send("Failed to fetch chunk");
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.status(response.status);
        const upstreamContentType = response.headers.get('content-type');
        res.setHeader('Content-Type', upstreamContentType || 'video/mp2t');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (response.headers.has('content-range')) {
            res.setHeader('Content-Range', response.headers.get('content-range'));
        }
        if (response.headers.has('accept-ranges')) {
            res.setHeader('Accept-Ranges', response.headers.get('accept-ranges'));
        }

        res.send(buffer);
        
    } catch (err) {
        console.error("Chunk Proxy Exception:", err.message);
        res.status(500).send("Chunk Proxy Error");
    }
});

app.get('/', (req, res) => {
    res.send("MaxPlay Secure Main Stream Gateway is Running 🚀");
});

ThePORT = 7860;
app.listen(7860, '0.0.0.0', () => {
    console.log(`MaxPlay Secure Master Gateway running on port 7860`);
});
