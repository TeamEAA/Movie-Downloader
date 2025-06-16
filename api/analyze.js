/**
 * このファイルは /api/analyze.js として配置します。
 * VercelやNetlifyにデプロイすると、自動的にサーバーレスAPIとして機能します。
 * * 必要なライブラリ:
 * npm install yt-dlp-wrap
 */
import { YtDlp } from 'yt-dlp-wrap';
import path from 'path';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { url } = JSON.parse(req.body);
        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ error: '無効なURLです。' });
        }
        
        // --- yt-dlp を使った実際の動画情報取得 ---
        // Vercel/Netlifyのサーバーレス環境では、yt-dlpのバイナリファイルを
        // プロジェクトに含めて、そのパスを指定する必要があります。
        const ytDlpPath = path.resolve(process.cwd(), './yt-dlp');
        const ytDlp = new YtDlp(ytDlpPath);

        const metadata = await ytDlp.getVideoInfo(url);
        
        // 必要な情報を抽出・整形
        const result = {
            title: metadata.title,
            thumbnailUrl: metadata.thumbnail,
            formats: metadata.formats
                // ダウンロードに適した形式（動画＋音声 or 音声のみ）をフィルタリング
                .filter(f => 
                    (f.vcodec !== 'none' && f.acodec !== 'none') || // 動画と音声が両方ある
                    (f.vcodec === 'none' && f.acodec !== 'none')     // 音声のみ
                )
                .map(f => {
                    const isAudioOnly = f.vcodec === 'none';
                    return {
                        quality: isAudioOnly ? `${Math.round(f.abr)}kbps` : `${f.height}p`,
                        format: isAudioOnly ? 'MP3' : 'MP4', // 便宜上MP3としていますが、元形式はm4aなど
                        url: f.url,
                        type: isAudioOnly ? 'audio' : 'video',
                    };
                })
                // 解像度で重複を除き、高いものから並べる
                .reverse()
                .filter((v, i, a) => a.findIndex(t => (t.quality === v.quality && t.format === v.format)) === i)
        };

        return res.status(200).json(result);

    } catch (error) {
        console.error(error);
        // エラーログからユーザーフレンドリーなメッセージを返す
        const errorMessage = error.stderr || error.message || 'サーバーで不明なエラーが発生しました。';
        if (errorMessage.includes('Unsupported URL')) {
            return res.status(400).json({ error: 'このURLには対応していません。' });
        }
        if (errorMessage.includes('Private video')) {
             return res.status(403).json({ error: 'この動画は非公開です。' });
        }
        return res.status(500).json({ error: '動画情報の解析に失敗しました。' });
    }
}
