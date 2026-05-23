import { Router } from 'express';
import multer from 'multer';
import { storagePut } from './storage';

const router = Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

router.post('/upload-tenant-logo', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Formato inválido. Use JPG, PNG, WebP ou SVG.' });
    }
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(7);
    const ext = req.file.originalname.split('.').pop() || 'png';
    const fileKey = `tenant-logos/${timestamp}-${randomSuffix}.${ext}`;
    const { url } = await storagePut(fileKey, req.file.buffer, req.file.mimetype);
    res.json({ url });
  } catch (error) {
    console.error('Erro ao fazer upload de logo:', error);
    res.status(500).json({ error: 'Erro ao fazer upload da logo' });
  }
});

router.post('/upload-ncg-photo', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    // Gerar nome único para o arquivo
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(7);
    const fileKey = `ncg-photos/${timestamp}-${randomSuffix}.jpg`;

    // Upload para S3
    const { url } = await storagePut(
      fileKey,
      req.file.buffer,
      req.file.mimetype
    );

    res.json({ url });
  } catch (error) {
    console.error('Erro ao fazer upload de foto NCG:', error);
    res.status(500).json({ error: 'Erro ao fazer upload da foto' });
  }
});

export default router;
