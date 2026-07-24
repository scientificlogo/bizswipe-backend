const clean = (s, max=500) => typeof s==='string' ? s.replace(/[<>]/g,'').trim().slice(0,max) : '';
const sanitizeListing = d => ({
  businessName: clean(d.businessName,200), industry: clean(d.industry,100),
  location: clean(d.location,200), city: clean(d.city,100), state: clean(d.state,100),
  type: clean(d.type,50), age: clean(d.age,20), employees: clean(d.employees,20),
  turnover: clean(d.turnover,50), askingPrice: clean(d.askingPrice,50),
  profitStatus: clean(d.profitStatus,50), description: clean(d.description,2000),
  reason: clean(d.reason,200), hasDebt: Boolean(d.hasDebt), debtAmount: clean(d.debtAmount||'',50),
  emoji: clean(d.emoji,10),
  bannerColor: /^#[0-9A-Fa-f]{6}$/.test(d.bannerColor)?d.bannerColor:'#1A1040',
  accentColor: /^#[0-9A-Fa-f]{6}$/.test(d.accentColor)?d.accentColor:'#A78BFA',
  tags: Array.isArray(d.tags)?d.tags.slice(0,10).map(t=>clean(t,50)):[],
});
module.exports = { clean, sanitizeListing };
