const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[A-Z][0-9A-Z]{1}$/;

const TEST_DATA = {
  '27AABCU9603R1ZP': { businessName:'TEST COMPANY PRIVATE LIMITED', status:'Active', businessType:'Private Limited', state:'Maharashtra', city:'Mumbai', registrationDate:'01/01/2020' },
  '27AABCS1429B1Z6': { businessName:'DEMO BUSINESS SOLUTIONS LLP',   status:'Active', businessType:'LLP',             state:'Maharashtra', city:'Pune',   registrationDate:'15/03/2019' },
  '29AABCU9603R1ZN': { businessName:'SAMPLE MANUFACTURING CO PVT LTD',status:'Active', businessType:'Private Limited', state:'Karnataka',   city:'Bangalore', registrationDate:'20/06/2018' },
};

const rateMap = new Map();
const isLimited = (ip) => {
  const now = Date.now();
  const list = (rateMap.get(ip)||[]).filter(t=>now-t<60000);
  if (list.length>=10) return true;
  list.push(now); rateMap.set(ip,list); return false;
};
setInterval(()=>rateMap.clear(), 5*60*1000);

module.exports = async (fastify) => {
  fastify.post('/gst', async (req, reply) => {
    const ip = req.headers['x-forwarded-for'] || req.ip;
    if (isLimited(ip)) return reply.code(429).send({ success:false, error:'Too many requests — 1 minute baad try karo' });

    const { gstin } = req.body;
    if (!gstin) return reply.code(400).send({ success:false, error:'GST number required' });

    const clean = gstin.toUpperCase().trim();
    if (clean.length!==15) return reply.code(400).send({ success:false, error:'GST 15 characters ka hona chahiye' });
    if (!GST_REGEX.test(clean)) return reply.code(400).send({ success:false, error:'GST format galat hai' });

    if (TEST_DATA[clean]) {
      return reply.send({ success:true, isTestMode:true, gstin:clean, ...TEST_DATA[clean] });
    }

    try {
      const controller = new AbortController();
      const timeout    = setTimeout(()=>controller.abort(), 8000);
      const res = await fetch(
        `https://gst-verification-api-get-profile-returns-data.p.rapidapi.com/v1/gstin/${clean}/details`,
        {
          headers: {
            'x-rapidapi-host': 'gst-verification-api-get-profile-returns-data.p.rapidapi.com',
            'x-rapidapi-key':  process.env.RAPIDAPI_KEY,
          },
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);
      const result = await res.json();

      if (result.error || !result.data) return reply.send({ success:false, error:'GST valid nahi hai' });
      const d = result.data;
      if (d.status!=='Active') return reply.send({ success:false, error:`GST "${d.status}" hai — Active number daalo` });

      return reply.send({
        success: true, isTestMode: false, gstin: clean,
        businessName:     d.trade_name || d.legal_name,
        legalName:        d.legal_name,
        status:           d.status,
        businessType:     d.business_constitution,
        state:            d.place_of_business_principal?.address?.state || '',
        city:             d.place_of_business_principal?.address?.location || '',
        registrationDate: d.registration_date || '',
      });
    } catch (err) {
      if (err.name==='AbortError') return reply.code(408).send({ success:false, error:'GST server slow — dobara try karo' });
      return reply.code(500).send({ success:false, error:'Server error — dobara try karo' });
    }
  });
};
