// ==========================================
// CUOTIFY - Rutas de pagos y estado de cuenta (montadas en /api)
//  POST /api/pagos                       -> registrar pago (RF-08)
//  POST /api/pagos/:id/anular            -> anular pago con motivo (RF-09)
//  GET  /api/viviendas/:id/estado-cuenta -> estado de cuenta (RF-11, RF-16)
//
// Mejoras respecto a la versión anterior:
//  - Recibo correlativo real: REC-2026-000001 (basado en id_pago)
//  - Valida que el pago no exceda el saldo (prueba P-05 -> 422)
//  - Verifica que la cuota/pago pertenezca a la comunidad del token (RNF-05)
//  - El residente solo consulta el estado de cuenta de SU vivienda (P-10)
//  - Registra bitácora en cada acción crítica (RF-17)
// ==========================================
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { verificarToken, soloAdministrador, registrarBitacora } = require('../middlewares/auth');

// Subconsulta: total pagado (no anulado) por cuota
const SQL_PAGOS_POR_CUOTA = `
  SELECT id_cuota, SUM(monto_pagado) AS pagado
  FROM pago WHERE anulado = FALSE
  GROUP BY id_cuota`;

const SQL_ESTADO = `
  CASE
    WHEN COALESCE(p.pagado, 0) >= c.monto THEN 'Pagado'
    WHEN COALESCE(p.pagado, 0) > 0 THEN 'Parcial'
    WHEN c.fecha_vencimiento < CURDATE() THEN 'Vencida'
    ELSE 'Pendiente'
  END`;

// ==========================================
// REGISTRAR PAGO (RF-08)
// Body: { id_cuota, monto_pagado, metodo, referencia }
// metodo: 'efectivo' | 'transferencia' | 'otro'
// ==========================================
router.post('/pagos', verificarToken, soloAdministrador, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const idCuota = parseInt(req.body?.id_cuota, 10);
    const montoPagado = parseFloat(req.body?.monto_pagado);
    const metodo = (req.body?.metodo || 'efectivo').toLowerCase();
    const referencia = (req.body?.referencia || '').trim();

    if (!idCuota) return res.status(422).json({ message: 'Falta el identificador de la cuota.' });
    if (isNaN(montoPagado) || montoPagado <= 0) {
      return res.status(422).json({ message: 'El monto pagado debe ser mayor a 0.' });
    }
    if (!['efectivo', 'transferencia', 'otro'].includes(metodo)) {
      return res.status(422).json({ message: "El método debe ser 'efectivo', 'transferencia' u 'otro'." });
    }

    await connection.beginTransaction();

    // La cuota debe pertenecer a una vivienda de ESTA comunidad (RNF-05)
    const [cuotaRows] = await connection.query(
      `SELECT c.id_cuota, c.monto, COALESCE(p.pagado, 0) AS pagado
       FROM cuota c
       JOIN vivienda v ON v.id_vivienda = c.id_vivienda
       LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p ON p.id_cuota = c.id_cuota
       WHERE c.id_cuota = ? AND v.id_comunidad = ?`,
      [idCuota, req.usuario.id_comunidad]
    );

    if (cuotaRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: 'Cuota no encontrada en su comunidad.' });
    }

    const cuota = cuotaRows[0];
    const saldo = parseFloat(cuota.monto) - parseFloat(cuota.pagado);

    // P-05: no se acepta un pago mayor que el saldo pendiente
    if (montoPagado > saldo + 0.001) {
      await connection.rollback();
      connection.release();
      return res.status(422).json({
        message: `El monto excede el saldo pendiente ($${saldo.toFixed(2)}).`
      });
    }

    // Si ya estaba pagada completa, no aceptar más pagos
    if (saldo <= 0.001) {
      await connection.rollback();
      connection.release();
      return res.status(422).json({ message: 'Esta cuota ya está completamente pagada.' });
    }

    // Registrar el pago (recibo provisional; se vuelve correlativo abajo)
    const [result] = await connection.query(
      `INSERT INTO pago (id_cuota, monto_pagado, fecha_pago, metodo, referencia, numero_recibo, id_registrado_por, anulado)
       VALUES (?, ?, NOW(), ?, ?, NULL, ?, FALSE)`,
      [idCuota, montoPagado, metodo, referencia || null, req.usuario.id_usuario]
    );

    // Número de recibo CORRELATIVO (RF-10): REC-AÑO-000123 según id_pago
    const numeroRecibo = `REC-${new Date().getFullYear()}-${String(result.insertId).padStart(6, '0')}`;
    await connection.query(
      'UPDATE pago SET numero_recibo = ? WHERE id_pago = ?',
      [numeroRecibo, result.insertId]
    );

    await connection.query(
      `INSERT INTO bitacora (id_usuario, accion, detalle)
       VALUES (?, 'registrar_pago', ?)`,
      [req.usuario.id_usuario, `Pago ${numeroRecibo} de $${montoPagado.toFixed(2)} a la cuota #${idCuota}`]
    );

    await connection.commit();
    connection.release();

    res.status(201).json({
      id_pago: result.insertId,
      numero_recibo: numeroRecibo,
      mensaje: 'Pago registrado correctamente.'
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    connection.release();
    res.status(500).json({ message: 'Error al registrar el pago', error: error.message });
  }
});

// ==========================================
// ANULAR PAGO (RF-09) - nunca se borra, conserva trazabilidad (RNF-06)
// Body: { motivo_anulacion }
// ==========================================
router.post('/pagos/:id/anular', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const idPago = req.params.id;
    const motivo = (req.body?.motivo_anulacion || '').trim();

    if (!motivo) {
      return res.status(422).json({ message: 'Indique el motivo de la anulación.' });
    }

    // Verificar que el pago pertenece a la comunidad del administrador
    const [rows] = await pool.query(
      `SELECT pa.id_pago FROM pago pa
       JOIN cuota c ON c.id_cuota = pa.id_cuota
       JOIN vivienda v ON v.id_vivienda = c.id_vivienda
       WHERE pa.id_pago = ? AND v.id_comunidad = ?`,
      [idPago, req.usuario.id_comunidad]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Pago no encontrado en su comunidad.' });
    }

    await pool.query(
      'UPDATE pago SET anulado = TRUE, motivo_anulacion = ? WHERE id_pago = ?',
      [motivo, idPago]
    );

    await registrarBitacora(req.usuario.id_usuario, 'anular_pago', `Pago #${idPago} anulado. Motivo: ${motivo}`);

    res.json({ mensaje: 'Pago anulado correctamente. La trazabilidad se ha conservado.' });
  } catch (error) {
    res.status(500).json({ message: 'Error al anular el pago', error: error.message });
  }
});

// ==========================================
// ESTADO DE CUENTA DE UNA VIVIENDA (RF-11)
// - Administrador: cualquier vivienda de su comunidad.
// - Residente: SOLO su propia vivienda (RF-16 / P-10).
// ==========================================
router.get('/viviendas/:id/estado-cuenta', verificarToken, async (req, res) => {
  try {
    const idVivienda = req.params.id;

    const [viviendaRows] = await pool.query(
      'SELECT * FROM vivienda WHERE id_vivienda = ?',
      [idVivienda]
    );
    if (viviendaRows.length === 0) {
      return res.status(404).json({ message: 'Vivienda no encontrada.' });
    }

    const vivienda = viviendaRows[0];

    // RNF-05 / RF-16: validar comunidad y propiedad
    if (req.usuario.rol === 'administrador') {
      if (vivienda.id_comunidad !== req.usuario.id_comunidad) {
        return res.status(403).json({ message: 'La vivienda pertenece a otra comunidad.' });
      }
    } else {
      if (vivienda.id_responsable !== req.usuario.id_usuario) {
        return res.status(403).json({ message: 'Solo puede consultar el estado de cuenta de su propia vivienda.' });
      }
    }

    const [cuotas] = await pool.query(
      `SELECT c.id_cuota, cc.nombre AS concepto, c.periodo, c.monto, c.fecha_vencimiento,
              COALESCE(p.pagado, 0) AS pagado,
              (c.monto - COALESCE(p.pagado, 0)) AS saldo,
              ${SQL_ESTADO} AS estado
       FROM cuota c
       JOIN concepto_cuota cc ON c.id_concepto = cc.id_concepto
       LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p ON p.id_cuota = c.id_cuota
       WHERE c.id_vivienda = ?
       ORDER BY c.periodo DESC`,
      [idVivienda]
    );

    res.json({ vivienda, historial_cuotas: cuotas });
  } catch (error) {
    res.status(500).json({ message: 'Error al consultar el estado de cuenta', error: error.message });
  }
});

module.exports = router;
