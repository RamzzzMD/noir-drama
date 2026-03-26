import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- MODUL SCRAPER (Sesuai kode dari Anda) ---
const CONFIG = {
    BASE_URL: 'https://dramabox.web.id',
    HEADERS: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
};

const request = async (url) => {
    try {
        const response = await axios.get(url, { headers: CONFIG.HEADERS });
        return cheerio.load(response.data);
    } catch (error) {
        throw new Error(`Network Error: ${error.message}`);
    }
};

const resolveUrl = (link) => {
    if (link && !link.startsWith('http')) {
        return `${CONFIG.BASE_URL}/${link.replace(/^\//, '')}`;
    }
    return link;
};

const getBookIdFromUrl = (urlStr) => {
    try {
        const match = urlStr.match(/\/watch\/(\d+)/);
        if (match) return match[1];

        const urlObj = new URL(urlStr);
        return urlObj.searchParams.get('bookId');
    } catch (e) {
        return null;
    }
};

const dramabox = {
    home: async () => {
        const $ = await request(`${CONFIG.BASE_URL}/in`);
        const latest = [];
        
        $('.drama-grid .drama-card').each((_, el) => {
            const link = resolveUrl($(el).find('.watch-button').attr('href'));
            const episodes = $(el).find('.drama-meta span[itemprop="numberOfEpisodes"]').text().replace(/[^0-9]/g, '');
            
            latest.push({
                title: $(el).find('.drama-title').text().trim(),
                book_id: getBookIdFromUrl(link),
                image: $(el).find('.drama-image img').attr('src') || $(el).find('.drama-image img').attr('data-src'),
                episodes: episodes
            });
        });

        const trending = [];
        $('.sidebar-widget .rank-list .rank-item').each((_, el) => {
            const link = resolveUrl($(el).attr('href'));
            const episodes = $(el).find('.rank-meta span').text().replace(/[^0-9]/g, '');

            trending.push({
                rank: $(el).find('.rank-number').text().trim(),
                title: $(el).find('.rank-title').text().trim(),
                book_id: getBookIdFromUrl(link),
                image: $(el).find('.rank-image img').attr('src') || $(el).find('.rank-image img').attr('data-src'),
                episodes: episodes
            });
        });

        return { latest, trending };
    },

    search: async (query) => {
        const targetUrl = `${CONFIG.BASE_URL}/search.php?lang=in&q=${encodeURIComponent(query)}`;
        const $ = await request(targetUrl);

        const results = [];
        $('.drama-grid .drama-card').each((_, el) => {
            const link = resolveUrl($(el).find('.watch-button').attr('href'));
            const viewsRaw = $(el).find('.drama-meta span').first().text().trim();
            
            results.push({
                title: $(el).find('.drama-title').text().trim(),
                book_id: getBookIdFromUrl(link),
                views: viewsRaw,
                image: $(el).find('.drama-image img').attr('src') || $(el).find('.drama-image img').attr('data-src')
            });
        });

        return results;
    },

    detail: async (bookId) => {
        if (!bookId) throw new Error("Book ID is required");

        const targetUrl = `${CONFIG.BASE_URL}/watch/${bookId}`;
        const $ = await request(targetUrl);

        const fullTitle = $('.video-title').text().trim();
        const cleanTitle = fullTitle.split('- Episode')[0].trim();
        
        const episodes = [];
        $('.episodes-grid .episode-btn').each((_, el) => {
            episodes.push({
                episode: parseInt($(el).text().trim()),
                id: $(el).attr('data-episode')
            });
        });

        const followersRaw = $('.video-meta span').first().text().trim();
        const totalEpRaw = $('span[itemprop="numberOfEpisodes"]').text().replace(/[^0-9]/g, '');

        return {
            book_id: bookId,
            title: cleanTitle,
            description: $('.video-description').text().trim(),
            thumbnail: $('meta[itemprop="thumbnailUrl"]').attr('content'),
            upload_date: $('meta[itemprop="uploadDate"]').attr('content'),
            stats: {
                followers: followersRaw,
                total_episodes: totalEpRaw,
            },
            episode_list: episodes
        };
    },

    stream: async (bookId, episode) => {
        if (!bookId || episode === undefined || episode === null) {
            throw new Error("Book ID and Episode are required");
        }

        const epPath = episode == 0 ? '' : `/ep-${episode}`;
        const targetUrl = `${CONFIG.BASE_URL}/watch/${bookId}${epPath}`;
        
        const $ = await request(targetUrl);
        const videoUrls = [];
        
        const rawHtml = $.html();
        const qualitiesRegex = /const\s+initialQualities\s*=\s*(\[.*?\]);/s;
        const match = rawHtml.match(qualitiesRegex);

        if (match && match[1]) {
            try {
                const qualitiesData = JSON.parse(match[1]);
                qualitiesData.forEach(item => {
                    if (item.quality && item.videoPath) {
                        videoUrls.push({
                            quality: `${item.quality}p`,
                            url: item.videoPath
                        });
                    }
                });
            } catch (error) {
                console.error("Gagal parsing JSON kualitas, lanjut ke metode fallback.");
            }
        }

        if (videoUrls.length === 0) {
            $('#qualityMenu .quality-option').each((_, el) => {
                const quality = $(el).attr('data-quality');
                const url = $(el).attr('data-url');
                
                if (quality && url) {
                    videoUrls.push({
                        quality: `${quality}p`,
                        url: url
                    });
                }
            });
        }

        if (videoUrls.length === 0) {
            let fallbackUrl = $('#mainVideo source').attr('src') || 
                              $('#mainVideo').attr('data-hls-url') || 
                              $('#mainVideo').attr('src');
                              
            if (fallbackUrl) {
                videoUrls.push({
                    quality: 'default',
                    url: fallbackUrl
                });
            }
        }

        return {
            book_id: bookId,
            episode: episode,
            videos: videoUrls
        };
    }
};

// --- ENDPOINTS API ---

app.get('/api/home', async (req, res) => {
    try {
        const data = await dramabox.home();
        res.status(200).json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ success: false, message: "Query parameter 'q' is required" });
        
        const data = await dramabox.search(q);
        res.status(200).json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/detail/:bookId', async (req, res) => {
    try {
        const { bookId } = req.params;
        const data = await dramabox.detail(bookId);
        res.status(200).json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/stream/:bookId/:episode', async (req, res) => {
    try {
        const { bookId, episode } = req.params;
        const data = await dramabox.stream(bookId, episode);
        res.status(200).json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- ENDPOINT AI GEMINI ---
app.post('/api/ai', async (req, res) => {
    try {
        const { prompt, systemText } = req.body;
        
        // Menggabungkan instruksi sistem dengan prompt karena API ini hanya menerima satu parameter prompt
        const fullPrompt = systemText 
            ? `[Instruksi Sistem: ${systemText}]\n\nPertanyaan pengguna: ${prompt}` 
            : prompt;

        const url = 'https://apii.ranzzajaah.my.id/api/ai/gemini-v2';
        const payload = {
            prompt: fullPrompt
        };

        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        // Mengambil teks jawaban berdasarkan struktur respon dari API baru
        const text = response.data?.result?.answer || "Maaf, tidak ada respon dari AI.";
        res.status(200).json({ success: true, text });
    } catch (error) {
        console.error("Gemini Backend Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Gagal memproses AI melalui backend." });
    }
});

// Default route
app.get('/', (req, res) => {
    res.send("Dramabox API is running. Access endpoints via /api/*");
});

// Start Server (Hanya jalan di lokal, Vercel akan menggunakan export)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Server is running on http://localhost:${PORT}`);
    });
}

// Export untuk Vercel Serverless Function
export default app;
