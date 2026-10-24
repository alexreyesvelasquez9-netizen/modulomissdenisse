// ==========================================
// CUOTIFY - Rutas de residentes (montadas en /api)
// ==========================================
const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const pool = require('./db');
const {
  verificarToken, soloAdministrador, registrarBitacora,
  generarClaveTemporal, esCorreoValido
} = require('./auth');

// ==========================================
// LISTAR RESIDENTES
// ==========================================
router.get('/residentes', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, u.nombre_completo, u.correo, u.telefono, u.activo,
              v.identificador AS vivienda
       FROM usuario u
       LEFT JOIN vivienda v ON v.id_responsable = u.id_usuario
       WHERE u.id_comunidad = ? AND u.rol = 'residente'
       ORDER BY u.nombre_completo`,
      [req.usuario.id_comunidad]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar residentes', error: error.message });
  }
});

// ==========================================
// CREAR RESIDENTE (RF-05)
// ==========================================
router.post('/residentes', verificarToken, soloAdministrador, async (req, res) => {
  const nombre = (req.body?.nombre_completo || '').trim();
  const correo = (req.body?.correo || '').trim().toLowerCase();
  const telefono = (req.body?.telefono || '').trim();
  const viviendaNombre = (req.body?.vivienda || '').trim();

  // Validaciones antes de obtener conexión
  if (!nombre) return res.status(422).json({ message: 'El nombre completo es obligatorio.' });
  if (!esCorreoValido(correo)) return res.status(422).json({ message: 'Ingrese un correo válido.' });
  if (!viviendaNombre) {
    return res.status(422).json({ message: 'Indique la vivienda del residente (ej. Casa 1).' });
  }

  const [existe] = await pool.query('SELECT id_usuario FROM usuario WHERE correo = ?', [correo]);
  if (existe.length > 0) {
    return res.status(409).json({ message: 'Ese correo ya está registrado.' });
  }

  const claveTemporal = generarClaveTemporal();
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(claveTemporal, salt);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [usuarioResult] = await connection.query(
      `INSERT INTO usuario (id_comunidad, nombre_completo, correo, telefono, contrasena_hash, rol, debe_cambiar_clave)
       VALUES (?, ?, ?, ?, ?, 'residente', TRUE)`,
      [req.usuario.id_comunidad, nombre, correo, telefono || null, hash]
    );
    const idUsuario = usuarioResult.insertId;

    let [viviendaRows] = await connection.query(
      'SELECT id_vivienda FROM vivienda WHERE id_comunidad = ? AND identificador = ?',
      [req.usuario.id_comunidad, viviendaNombre]
    );
    let idVivienda;
    if (viviendaRows.length > 0) {
      idVivienda = viviendaRows[0].id_vivienda;
    } else {
      const [nuevaVivienda] = await connection.query(
        'INSERT INTO vivienda (id_comunidad, identificador) VALUES (?, ?)',
        [req.usuario.id_comunidad, viviendaNombre]
      );
      idVivienda = nuevaVivienda.insertId;
    }

    await connection.query(
      'UPDATE vivienda SET id_responsable = ? WHERE id_vivienda = ?',
      [idUsuario, idVivienda]
    );

    await connection.query(
      `INSERT INTO bitacora (id_usuario, accion, detalle)
       VALUES (?, 'crear_residente', ?)`,
      [req.usuario.id_usuario, `Residente ${nombre} (${correo}) vinculado a "${viviendaNombre}"`]
    );

    await connection.commit();
    connection.release();

    res.status(201).json({
      mensaje: 'Residente creado. Entregue la clave temporal al residente.',
      id_usuario: idUsuario,
      id_vivienda: idVivienda,
      clave_temporal: claveTemporal
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    connection.release();
    res.status(500).json({ message: 'Error al crear el residente', error: error.message });
  }
});

// ==========================================
// RESTABLECER CLAVE DE UN RESIDENTE (RF-05)
// ==========================================
router.post('/residentes/:id/restablecer-clave', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const idResidente = req.params.id;

    const [rows] = await pool.query(
      `SELECT id_usuario, nombre_completo FROM usuario
       WHERE id_usuario = ? AND id_comunidad = ? AND rol = 'residente'`,
      [idResidente, req.usuario.id_comunidad]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Residente no encontrado.' });
    }

    const claveTemporal = generarClaveTemporal();
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(claveTemporal, salt);

    await pool.query(
      `UPDATE usuario
       SET contrasena_hash = ?, debe_cambiar_clave = TRUE,
           intentos_fallidos = 0, bloqueado_hasta = NULL
       WHERE id_usuario = ?`,
      [hash, idResidente]
    );

    await registrarBitacora(
      req.usuario.id_usuario, 'restablecer_clave',
      `Clave restablecida para ${rows[0].nombre_completo}`
    );

    res.json({
      mensaje: 'Clave temporal generada. Entréguela al residente.',
      clave_temporal: claveTemporal
    });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo restablecer la clave', error: error.message });
  }
});

module.exports = router;
