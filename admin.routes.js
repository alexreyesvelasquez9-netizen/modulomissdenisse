// ==========================================
// CUOTIFY - Rutas del panel, mora, recordatorios y reportes (montadas en /api)
//  GET  /api/dashboard/resumen     -> { solventes, deudores, total_viviendas }
//  GET  /api/deudores              -> viviendas en mora (RF-13)
//  GET  /api/solventes             -> viviendas al día
//  GET  /api/recordatorios         -> viviendas con deuda para notificar (RF-14)
//  POST /api/recordatorios/enviar  -> registra el recordatorio enviado (RF-14)
//  GET  /api/reportes?mes=&anio=   -> recaudo/estado por periodo (RF-15)
//  GET  /api/bitacora              -> últimas acciones críticas (RF-17)
// ==========================================
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { verificarToken, soloAdministrador, registrarBitacora } = require('./auth');

// Subconsulta: total pagado (no anulado) por cuota
const SQL_PAGOS_POR_CUOTA = `
  SELECT id_cuota, SUM(monto_pagado) AS pagado
  FROM pago WHERE anulado = FALSE
  GROUP BY id_cuota`;

// Subconsulta: ids de viviendas CON mora (cuota vencida con saldo pendiente)
const SQL_VIVIENDAS_EN_MORA = `
  SELECT DISTINCT v2.id_vivienda
  FROM vivienda v2
  JOIN cuota c2 ON c2.id_vivienda = v2.id_vivienda AND c2.fecha_vencimiento < CURDATE()
  LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p2 ON p2.id_cuota = c2.id_cuota
  WHERE v2.id_comunidad = ? AND v2.activa = TRUE
    AND c2.monto > COALESCE(p2.pagado, 0)`;

// ==========================================
// RESUMEN DEL PANEL (gráfica de morosidad)
// ==========================================
router.get('/dashboard/resumen', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM vivienda WHERE id_comunidad = ? AND activa = TRUE',
      [req.usuario.id_comunidad]
    );
    const [[{ deudores }]] = await pool.query(
      `SELECT COUNT(*) AS deudores FROM (${SQL_VIVIENDAS_EN_MORA}) AS en_mora`,
      [req.usuario.id_comunidad]
    );
    res.json({
      total_viviendas: total,
      deudores: deudores,
      solventes: Math.max(total - deudores, 0)
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al calcular el resumen', error: error.message });
  }
});

// ==========================================
// LISTADO DE DEUDORES (RF-13)
// [{ id_vivienda, vivienda, propietario, meses_adeudados, deuda }]
// ==========================================
router.get('/deudores', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.id_vivienda, v.identificador AS vivienda,
              u.nombre_completo AS propietario,
              COUNT(DISTINCT c.periodo) AS meses_adeudados,
              SUM(c.monto - COALESCE(p.pagado, 0)) AS deuda
       FROM vivienda v
       JOIN cuota c ON c.id_vivienda = v.id_vivienda AND c.fecha_vencimiento < CURDATE()
       LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p ON p.id_cuota = c.id_cuota
       LEFT JOIN usuario u ON u.id_usuario = v.id_responsable
       WHERE v.id_comunidad = ? AND v.activa = TRUE
         AND c.monto > COALESCE(p.pagado, 0)
       GROUP BY v.id_vivienda, v.identificador, u.nombre_completo
       ORDER BY deuda DESC`,
      [req.usuario.id_comunidad]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar deudores', error: error.message });
  }
});

// ==========================================
// LISTADO DE SOLVENTES (viviendas al día)
// [{ id_vivienda, vivienda, propietario, monto }] (monto pagado este mes)
// ==========================================
router.get('/solventes', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.id_vivienda, v.identificador AS vivienda,
              u.nombre_completo AS propietario,
              COALESCE(pg.pagado_mes, 0) AS monto
       FROM vivienda v
       LEFT JOIN usuario u ON u.id_usuario = v.id_responsable
       LEFT JOIN (
         SELECT c3.id_vivienda, SUM(p3.monto_pagado) AS pagado_mes
         FROM pago p3
         JOIN cuota c3 ON c3.id_cuota = p3.id_cuota
         WHERE p3.anulado = FALSE
           AND MONTH(p3.fecha_pago) = MONTH(CURDATE())
           AND YEAR(p3.fecha_pago) = YEAR(CURDATE())
         GROUP BY c3.id_vivienda
       ) pg ON pg.id_vivienda = v.id_vivienda
       WHERE v.id_comunidad = ? AND v.activa = TRUE
         AND v.id_vivienda NOT IN (${SQL_VIVIENDAS_EN_MORA})
       ORDER BY v.identificador`,
      [req.usuario.id_comunidad, req.usuario.id_comunidad]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar solventes', error: error.message });
  }
});

// ==========================================
// RECORDATORIOS: viviendas en mora por notificar (RF-14)
// ==========================================
router.get('/recordatorios', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.id_vivienda, v.identificador AS vivienda,
              COUNT(DISTINCT c.periodo) AS meses_adeudados,
              SUM(c.monto - COALESCE(p.pagado, 0)) AS saldo
       FROM vivienda v
       JOIN cuota c ON c.id_vivienda = v.id_vivienda AND c.fecha_vencimiento < CURDATE()
       LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p ON p.id_cuota = c.id_cuota
       WHERE v.id_comunidad = ? AND v.activa = TRUE
         AND c.monto > COALESCE(p.pagado, 0)
       GROUP BY v.id_vivienda, v.identificador
       ORDER BY v.identificador`,
      [req.usuario.id_comunidad]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar recordatorios', error: error.message });
  }
});

// ==========================================
// ENVIAR RECORDATORIO (registro interno dentro de la app, RF-14)
// Body: { id_vivienda }
// ==========================================
router.post('/recordatorios/enviar', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const idVivienda = parseInt(req.body?.id_vivienda, 10);
    if (!idVivienda) return res.status(422).json({ message: 'Falta el identificador de la vivienda.' });

    const [rows] = await pool.query(
      'SELECT id_vivienda, identificador FROM vivienda WHERE id_vivienda = ? AND id_comunidad = ?',
      [idVivienda, req.usuario.id_comunidad]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Vivienda no encontrada en su comunidad.' });
    }

    await pool.query(
      `INSERT INTO recordatorio (id_vivienda, id_enviado_por, mensaje)
       VALUES (?, ?, ?)`,
      [idVivienda, req.usuario.id_usuario, 'Recordatorio de pago de cuotas pendientes.']
    );

    await registrarBitacora(
      req.usuario.id_usuario, 'enviar_recordatorio',
      `Recordatorio enviado a "${rows[0].identificador}"`
    );

    res.json({ mensaje: `Recordatorio enviado a la vivienda ${rows[0].identificador}.` });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo enviar el recordatorio', error: error.message });
  }
});

// ==========================================
// REPORTES POR PERIODO (RF-15)
// ?mes=10&anio=2026 -> [{ vivienda, propietario, monto, estado }]
// ==========================================
router.get('/reportes', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const mes = parseInt(req.query.mes, 10) || new Date().getMonth() + 1;
    const anio = parseInt(req.query.anio, 10) || new Date().getFullYear();

    const [rows] = await pool.query(
      `SELECT v.identificador AS vivienda,
              u.nombre_completo AS propietario,
              c.monto,
              CASE
                WHEN COALESCE(p.pagado, 0) >= c.monto THEN 'Pagado'
                WHEN COALESCE(p.pagado, 0) > 0 THEN 'Parcial'
                ELSE 'Pendiente'
              END AS estado
       FROM cuota c
       JOIN vivienda v ON v.id_vivienda = c.id_vivienda
       LEFT JOIN usuario u ON u.id_usuario = v.id_responsable
       LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p ON p.id_cuota = c.id_cuota
       WHERE v.id_comunidad = ? AND YEAR(c.periodo) = ? AND MONTH(c.periodo) = ?
       ORDER BY v.identificador`,
      [req.usuario.id_comunidad, anio, mes]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al generar el reporte', error: error.message });
  }
});

// ==========================================
// BITÁCORA (RF-17) - últimas 100 acciones de la comunidad
// ==========================================
router.get('/bitacora', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT b.id_bitacora, b.accion, b.detalle, b.fecha_hora,
              u.nombre_completo AS usuario
       FROM bitacora b
       JOIN usuario u ON u.id_usuario = b.id_usuario
       WHERE u.id_comunidad = ?
       ORDER BY b.fecha_hora DESC
       LIMIT 100`,
      [req.usuario.id_comunidad]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al consultar la bitácora', error: error.message });
  }
});

module.exports = router;
