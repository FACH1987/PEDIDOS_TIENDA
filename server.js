require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const sql = require('mssql');

const app = express();
const port = Number(process.env.PORT || 3000);
let poolPromise;
const demoStores = Array.from({ length: 5 }, (_, index) => ({
  id: index + 1,
  name: `Tienda ${index + 1}`
}));

const demoProducts = [
  { id: 1, name: 'Arroz 1 kg', price: 1.9, stock: 40 },
  { id: 2, name: 'Aceite vegetal 1 L', price: 3.75, stock: 24 },
  { id: 3, name: 'Leche entera 1 L', price: 1.25, stock: 60 },
  { id: 4, name: 'Café molido 250 g', price: 4.8, stock: 18 },
  { id: 5, name: 'Pasta 500 g', price: 1.45, stock: 35 },
  { id: 6, name: 'Atún en lata', price: 2.1, stock: 28 }
];

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

function tableName(value, fallback) {
  const name = value || fallback;
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/.test(name)) throw new Error('Nombre de tabla no válido');
  return name.split('.').map((part) => `[${part}]`).join('.');
}

function databaseEnabled() {
  return String(process.env.DB_ENABLED).toLowerCase() === 'true';
}

function requireConfiguration() {
  if (!databaseEnabled()) return;
  const required = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
}

async function getPool() {
  if (!poolPromise) {
    const [server, instanceName] = String(process.env.DB_SERVER || '').split('\\', 2);
    poolPromise = sql.connect({
      server,
      port: Number(process.env.DB_PORT || 1433),
      database: process.env.DB_DATABASE,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options: {
        encrypt: String(process.env.DB_ENCRYPT).toLowerCase() !== 'false',
        trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE).toLowerCase() === 'true',
        ...(instanceName ? { instanceName } : {})
      }
    });
    poolPromise.catch(() => { poolPromise = undefined; });
  }
  return poolPromise;
}

requireConfiguration();

app.get('/api/stores', async (_request, response) => {
  if (!databaseEnabled()) return response.json(demoStores);
  try {
    const pool = await getPool();
    const result = await pool.request().query(
      'SELECT TOP (5) IdAlmacen AS id, Nombre AS name FROM [app].[Almacenes] ORDER BY IdAlmacen'
    );
    response.json(result.recordset);
  } catch (error) {
    console.error('Error cargando tiendas:', error.message);
    response.status(503).json({ error: 'No se pudo cargar el catálogo desde SQL Server.' });
  }
});

app.get('/api/products', async (_request, response) => {
  if (!databaseEnabled()) return response.json(demoProducts);

  try {
    const pool = await getPool();
    const productsTable = tableName(process.env.PRODUCTS_TABLE, 'app.Productos');
    const result = await pool.request().query(
      `SELECT p.Codigo AS id, p.Nombre AS name, p.CostoUnitario AS price,
              ISNULL(SUM(e.CantidadRestaurante), 0) AS stock
       FROM ${productsTable} AS p
       LEFT JOIN [app].[ExistenciasRestaurantes] AS e ON e.CodigoProducto = p.Codigo
       GROUP BY p.Codigo, p.Nombre, p.CostoUnitario ORDER BY p.Nombre`
    );
    response.json(result.recordset);
  } catch (error) {
    console.error('Error cargando productos:', error.message);
    response.status(503).json({ error: 'No se pudo conectar con SQL Server.' });
  }
});

app.post('/api/orders', async (request, response) => {
  const { storeId, customerName, notes, items } = request.body || {};
  const validItems = Array.isArray(items)
    ? items.filter((item) => typeof item.productId === 'string' && /^[^\s]{1,50}$/.test(item.productId) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 999)
    : [];

  const normalizedName = typeof customerName === 'string' ? customerName.trim() : '';
  const normalizedNotes = typeof notes === 'string' ? notes.trim() : '';
  const uniqueProductIds = new Set(validItems.map((item) => item.productId));
  const availableStores = databaseEnabled() ? null : demoStores;
  if ((availableStores && !availableStores.some((store) => store.id === Number(storeId))) || !Number.isInteger(Number(storeId)) || normalizedName.length < 2 || normalizedName.length > 150 || normalizedNotes.length > 500 || validItems.length === 0 || uniqueProductIds.size !== validItems.length) {
    return response.status(400).json({ error: 'Indica tienda, nombre y al menos un producto válido.' });
  }

  if (!databaseEnabled()) {
    return response.status(201).json({
      orderId: `DEMO-${Date.now()}`,
      message: 'Pedido registrado en modo demostración.'
    });
  }

  let transaction;
  try {
    const pool = await getPool();
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const ordersTable = tableName(process.env.ORDERS_TABLE, 'Pedidos');
    const linesTable = tableName(process.env.ORDER_LINES_TABLE, 'DetallePedidos');
    const orderResult = await new sql.Request(transaction)
      .input('storeId', sql.Int, Number(storeId))
      .input('customerName', sql.NVarChar(150), normalizedName)
      .input('notes', sql.NVarChar(500), normalizedNotes || null)
      .query(`INSERT INTO ${ordersTable} (TiendaId, Cliente, Observaciones, Fecha, Estado)
              OUTPUT INSERTED.Id AS orderId
              VALUES (@storeId, @customerName, @notes, GETDATE(), 'Pendiente')`);
    const orderId = orderResult.recordset[0].orderId;

    for (const item of validItems) {
      await new sql.Request(transaction)
        .input('orderId', sql.Int, orderId)
        .input('productCode', sql.NVarChar(50), item.productId)
        .input('quantity', sql.Int, item.quantity)
        .query(`INSERT INTO ${linesTable} (PedidoId, CodigoProducto, Cantidad)
          VALUES (@orderId, @productCode, @quantity)`);
    }
    await transaction.commit();
    response.status(201).json({ orderId, message: 'Pedido registrado correctamente.' });
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => {});
    console.error('Error guardando pedido:', error.message);
    response.status(500).json({ error: 'No se pudo guardar el pedido.' });
  }
});

app.listen(port, () => console.log(`Pedidos Tiendas disponible en http://localhost:${port}`));