const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./config/db');
const { verificarToken, soloAdministrador } = require('./middlewares/auth');

// Importación de las rutas modulares
const cuotasRoutes = require('./routes/cuotas.routes');

const app = express();
app.use(express.json());
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET || 'secreto_super_seguro';

// ==========================================
// ENDPOINT: LOGIN (Autenticación)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { correo, contrasena } = req.body;
    const [rows] = await pool.query('SELECT * FROM usuario WHERE correo = ? AND activo = TRUE', [correo]);
    
    if (rows.length === 0) return res.status(401).json({ message: 'Credenciales inválidas.' });
    
    const usuario = rows[0];
    const passwordMatch = await bcrypt.compare(contrasena, usuario.contrasena_hash);
    
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Credenciales inválidas.' });
    }

    // Generar token JWT con vigencia
    const token = jwt.sign(
      { id_usuario: usuario.id_usuario, id_comunidad: usuario.id_comunidad, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      usuario: {
        id_usuario: usuario.id_usuario,
        nombre_completo: usuario.nombre_completo,
        correo: usuario.correo,
        rol: usuario.rol,
        debe_cambiar_clave: usuario.debe_cambiar_clave
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error interno del servidor', error: error.message });
  }
});

// ==========================================
// ENDPOINT: CAMBIAR CONTRASEÑA
// ==========================================
app.post('/api/auth/cambiar-clave', verificarToken, async (req, res) => {
  try {
    const { clave_nueva } = req.body;
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(clave_nueva, salt);

    await pool.query(
      'UPDATE usuario SET contrasena_hash = ?, debe_cambiar_clave = FALSE WHERE id_usuario = ?',
      [hash, req.usuario.id_usuario]
    );

    res.json({ mensaje: 'Contraseña actualizada exitosamente.' });
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar la contraseña', error: error.message });
  }
});

// ==========================================
// REGISTRO DE RUTAS MODULARES
// ==========================================
// Todas las peticiones a /api/cuotas serán manejadas por cuotas.routes.js
app.use('/api/cuotas', cuotasRoutes);

// ==========================================
// ENDPOINT: REGISTRAR PAGO Y RECIBO
// ==========================================
app.post('/api/pagos', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const { id_cuota, monto_pagado, metodo, referencia } = req.body;
    
    if (monto_pagado <= 0) {
      return res.status(422).json({ message: 'El monto pagado debe ser mayor a 0.' });
    }

    const numero_recibo = `REC-${new Date().toISOString().slice(0,7).replace('-','')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const [result] = await pool.query(
      `INSERT INTO pago (id_cuota, monto_pagado, fecha_pago, metodo, referencia, numero_recibo, id_registrado_por, anulado)
       VALUES (?, ?, NOW(), ?, ?, ?, ?, FALSE)`,
      [id_cuota, monto_pagado, metodo, referencia || null, numero_recibo, req.usuario.id_usuario]
    );

    res.status(201).json({
      id_pago: result.insertId,
      numero_recibo,
      mensaje: 'Pago registrado correctamente.'
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar el pago', error: error.message });
  }
});

// ==========================================
// ENDPOINT: ANULAR PAGO
// ==========================================
app.post('/api/pagos/:id/anular', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const { motivo_anulacion } = req.body;
    const idPago = req.params.id;

    await pool.query(
      'UPDATE pago SET anulado = TRUE, motivo_anulacion = ? WHERE id_pago = ?',
      [motivo_anulacion, idPago]
    );

    res.json({ mensaje: 'Pago anulado correctamente. La trazabilidad se ha conservado.' });
  } catch (error) {
    res.status(500).json({ message: 'Error al anular el pago', error: error.message });
  }
});

// ==========================================
// ENDPOINT: ESTADO DE CUENTA
// ==========================================
app.get('/api/viviendas/:id/estado-cuenta', verificarToken, async (req, res) => {
  try {
    const idVivienda = req.params.id;

    const [viviendaRows] = await pool.query('SELECT * FROM vivienda WHERE id_vivienda = ?', [idVivienda]);
    if (viviendaRows.length === 0) return res.status(404).json({ message: 'Vivienda no encontrada.' });

    const [cuotas] = await pool.query(
      `SELECT c.id_cuota, cc.nombre AS concepto, c.periodo, c.monto, c.fecha_vencimiento 
       FROM cuota c
       JOIN concepto_cuota cc ON c.id_concepto = cc.id_concepto
       WHERE c.id_vivienda = ? ORDER BY c.periodo DESC`,
      [idVivienda]
    );

    res.json({
      vivienda: viviendaRows[0],
      historial_cuotas: cuotas
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al consultar el estado de cuenta', error: error.message });
  }
});

// Inicialización del servidor puerto 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor API REST de Cuotify corriendo en el puerto ${PORT}`);
});