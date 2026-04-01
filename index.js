import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import OpenAI from 'openai';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '15mb' }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ALLOWED_CATEGORIES = [
  'Home',
  'Appliances',
  'Car',
  'Utilities',
  'Electronics',
  'Subscription',
  'Insurance',
  'Receipt',
  'Warranty',
  'Other',
];

const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests',
    details: 'Please wait before analyzing more scans.',
  },
});

function normalizeCategory(value) {
  if (!value) return 'Other';
  const trimmed = value.trim();

  const direct = ALLOWED_CATEGORIES.find(
    (item) => item.toLowerCase() === trimmed.toLowerCase()
  );
  if (direct) return direct;

  const map = {
    bill: 'Utilities',
    utility: 'Utilities',
    utilities: 'Utilities',
    invoice: 'Receipt',
    receipt: 'Receipt',
    warranty: 'Warranty',
    insurance: 'Insurance',
    subscription: 'Subscription',
    electronic: 'Electronics',
    electronics: 'Electronics',
    appliance: 'Appliances',
    appliances: 'Appliances',
    home: 'Home',
    car: 'Car',
  };

  return map[trimmed.toLowerCase()] || 'Other';
}

function normalizeDate(value) {
  if (!value) return '';

  const trimmed = value.trim();
  if (!trimmed) return '';

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return '';

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

app.get('/health', (_, res) => {
  res.json({ ok: true });
});

app.post('/analyze-scan', analyzeLimiter, async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({
        error: 'Missing image',
        details: 'imageBase64 is required.',
      });
    }

    if (imageBase64.length < 1000) {
      return res.status(400).json({
        error: 'Invalid image',
        details: 'Image data is too small to analyze.',
      });
    }

    if (imageBase64.length > 10_000_000) {
      return res.status(413).json({
        error: 'Image too large',
        details: 'Please use a smaller image.',
      });
    }

    console.log('Analyze request received. base64 length:', imageBase64.length);

    const response = await client.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Extract fields from this household document image. ' +
                'Return JSON only. ' +
                'Rules: ' +
                '1) title must not be empty if a heading, merchant name, or obvious document name is visible. ' +
                '2) category must be one of: Home, Appliances, Car, Utilities, Electronics, Subscription, Insurance, Receipt, Warranty, Other. ' +
                '3) reminderDate should only be included if a meaningful trackable date is visible; otherwise use empty string. ' +
                '4) notes should be a short plain-English summary. ' +
                '5) Be conservative. Do not invent dates.'
            },
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${imageBase64}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          strict: true,
          name: 'document_extraction',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              category: {
                type: 'string',
                enum: ALLOWED_CATEGORIES,
              },
              reminderDate: { type: 'string' },
              notes: { type: 'string' },
            },
            required: ['title', 'category', 'reminderDate', 'notes'],
          },
        },
      },
    });

    const text = response.output_text?.trim() || '';

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const safeResult = {
      title: parsed?.title?.trim() || 'Untitled Document',
      category: normalizeCategory(parsed?.category),
      reminderDate: normalizeDate(parsed?.reminderDate),
      notes: parsed?.notes?.trim() || '',
    };

    const detectedFields = [
      safeResult.title ? 'title' : null,
      safeResult.category ? 'category' : null,
      safeResult.reminderDate ? 'reminderDate' : null,
      safeResult.notes ? 'notes' : null,
    ].filter(Boolean);

    res.json({
      ...safeResult,
      detectedFields,
    });
  } catch (error) {
    console.error('ANALYZE ERROR:', error?.message || error);

    res.status(500).json({
      error: 'Analyze failed',
      details: 'The server could not analyze the scan.',
    });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`PaperNest backend running on port ${port}`);
});
