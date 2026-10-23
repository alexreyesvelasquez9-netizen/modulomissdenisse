// ==========================================
// CUOTIFY - Rutas de viviendas y conceptos de cuota (montadas en /api)
//  GET    /api/viviendas          -> listar (paginado, RNF-02)
//  POST   /api/viviendas          -> crear vivienda (RF-04)
//  PUT    /api/viviendas/:id      -> editar / activar / desactivar (RF-04)
//  GET    /api/conceptos          -> listar conceptos (RF-06)
//  POST   /api/conceptos          -> crear concepto (RF-06)
//  PUT    /api/conceptos/:id      -> editar monto / activar / desactivar (RF-06)
// Todas las consultas están aisladas por comunidad del token (RNF-05 / P-10)
// ==========================================
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { verificarToken, soloAdministrador, registrarBitacora } = require('./auth');

// Helper de paginación: ?pagina=1&limite=20  (máximo 100 por página)
function paginaYLimite(req) {
  const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
  let limite = parseInt(req.query.limite, 10) || 20;
  if (limite < 1) limite = 20;
  if (limite > 100) limite = 100;
  return { pagina, limite, offset: (pagina - 1) * limite };
}

// ==========================================
// VIVIENDAS
// ==========================================
router.get('/viviendas', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const { limite, offset } = paginaYLimite(req);
    const [rows] = await pool.query(
      `SELECT v.id_vivienda, v.identificador, v.activa, u.nombre_completo AS responsable
       FROM vivienda v
       LEFT JOIN usuario u ON u.id_usuario = v.id_responsable
       WHERE v.id_comunidad = ?
       ORDER BY v.identificador
       LIMIT ? OFFSET ?`,
      [req.usuario.id_comunidad, limite, offset]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar viviendas', error: error.message });
  }
});

router.post('/viviendas', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const identificador = (req.body?.identificador || '').trim();
    if (!identificador) {
      return res.status(422).json({ message: 'El identificador de la vivienda es obligatorio (ej. Casa 1).' });
    }
    try {
      const [result] = await pool.query(
        'INSERT INTO vivienda (id_comunidad, identificador) VALUES (?, ?)',
        [req.usuario.id_comunidad, identificador]
      );
      await registrarBitacora(req.usuario.id_usuario, 'crear_vivienda', `Vivienda "${identificador}" creada`);
      res.status(201).json({ id_vivienda: result.insertId, mensaje: 'Vivienda creada correctamente.' });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Ya existe una vivienda con ese identificador.' });
      }
      throw err;
    }
  } catch (error) {
    res.status(500).json({ message: 'Error al crear la vivienda', error: error.message });
  }
});

router.put('/viviendas/:id', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const idVivienda = req.params.id;
    const { identificador, activa } = req.body || {};

    // Verificar que la vivienda pertenece a la comunidad del administrador
    const [rows] = await pool.query(
      'SELECT id_vivienda FROM vivienda WHERE id_vivienda = ? AND id_comunidad = ?',
      [idVivienda, req.usuario.id_comunidad]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Vivienda no encontrada.' });
    }

    await pool.query(
      'UPDATE vivienda SET identificador = COALESCE(?, identificador), activa = COALESCE(?, activa) WHERE id_vivienda = ?',
      [identificador?.trim() || null, activa === undefined ? null : (activa ? 1 : 0), idVivienda]
    );

    await registrarBitacora(req.usuario.id_usuario, 'editar_vivienda', `Vivienda #${idVivienda} actualizada`);
    res.json({ mensaje: 'Vivienda actualizada correctamente.' });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar la vivienda', error: error.message });
  }
});

// ==========================================
// CONCEPTOS DE CUOTA
// ==========================================
router.get('/conceptos', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_concepto, nombre, monto, activo
       FROM concepto_cuota
       WHERE id_comunidad = ?
       ORDER BY nombre`,
      [req.usuario.id_comunidad]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar conceptos', error: error.message });
  }
});

router.post('/conceptos', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const nombre = (req.body?.nombre || '').trim();
    const monto = parseFloat(req.body?.monto);

    if (!nombre) return res.status(422).json({ message: 'El nombre del concepto es obligatorio.' });
    if (isNaN(monto) || monto <= 0) return res.status(422).json({ message: 'El monto debe ser mayor a 0.' });

    const [result] = await pool.query(
      'INSERT INTO concepto_cuota (id_comunidad, nombre, monto) VALUES (?, ?, ?)',
      [req.usuario.id_comunidad, nombre, monto]
    );
    await registrarBitacora(req.usuario.id_usuario, 'crear_concepto', `Concepto "${nombre}" con monto ${monto}`);
    res.status(201).json({ id_concepto: result.insertId, mensaje: 'Concepto creado correctamente.' });
  } catch (error) {
    res.status(500).json({ message: 'Error al crear el concepto', error: error.message });
  }
});

router.put('/conceptos/:id', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const idConcepto = req.params.id;
    const { nombre, monto, activo } = req.body || {};

    if (monto !== undefined && (isNaN(parseFloat(monto)) || parseFloat(monto) <= 0)) {
      return res.status(422).json({ message: 'El monto debe ser mayor a 0.' });
    }

    const [rows] = await pool.query(
      'SELECT id_concepto FROM concepto_cuota WHERE id_concepto = ? AND id_comunidad = ?',
      [idConcepto, req.usuario.id_comunidad]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Concepto no encontrado.' });

    await pool.query(
      `UPDATE concepto_cuota
       SET nombre = COALESCE(?, nombre),
           monto = COALESCE(?, monto),
           activo = COALESCE(?, activo)
       WHERE id_concepto = ?`,
      [nombre?.trim() || null, monto !== undefined ? parseFloat(monto) : null,
       activo === undefined ? null : (activo ? 1 : 0), idConcepto]
    );

    await registrarBitacora(req.usuario.id_usuario, 'editar_concepto', `Concepto #${idConcepto} actualizado`);
    res.json({ mensaje: 'Concepto actualizado correctamente.' });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar el concepto', error: error.message });
  }
});

module.exports = router;
