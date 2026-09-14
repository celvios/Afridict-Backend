import { personas } from './fixtures.js';
import { createTradingDemo } from './demo-trading.js';

if (process.env.NODE_ENV === 'production') throw new Error('The demo cannot run in production');
const { app, db } = await createTradingDemo();
try {
  await app.listen({ host: '127.0.0.1', port: 3000 });
  console.log('Synthetic frontend demo: http://127.0.0.1:3000/docs');
  console.log('Bearer demo.<persona> selects a synthetic persona:', Object.keys(personas).join(', '));
  console.log('Published binary, categorical, and scalar markets have open books, synthetic depth and example fills.');
  console.log('All data is synthetic and disappears on shutdown. No external identity, payments or chain transactions.');
} catch (error) {
  await app.close(); await db.close(); throw error;
}
async function stop() { await app.close(); await db.close(); }
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
