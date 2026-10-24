// ==========================================
// CUOTIFY - Rutas de cuotas (montadas en /api)
// ==========================================
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { verificarToken, soloAdministrador, registrarBitacora } = require('./auth');

// Subconsulta reutilizable: total pagado (no anulado) por cuota
const SQL_PAGOS_POR_CUOTA = `
  SELECT id_cuota, SUM(monto_pagado) AS pagado
  FROM pago WHERE anulado = FALSE
  GROUP BY id_cuota`;

// Expresión del estado de una cuota a partir de sus pagos (RNF-06)
const SQL_ESTADO = `
  CASE
    WHEN COALESCE(p.pagado, 0) >= c.monto THEN 'Pagado'
    WHEN COALESCE(p.pagado, 0) > 0 THEN 'Parcial'
    WHEN c.fecha_vencimiento < CURDATE() THEN 'Vencida'
    ELSE 'Pendiente'
  END`;

// ==========================================
// GENERAR CUOTAS DEL MES (RF-07 / P-04)
// ==========================================
router.post('/cuotas/generar', verificarToken, soloAdministrador, async (req, res) => {
  const { mes, anio, periodo, fecha_vencimiento } = req.body || {};

  let periodoSQL = null;
  let vencimientoSQL = null;

  // Validaciones antes de obtener la conexión
  if (mes && anio) {
    const mesNum = parseInt(mes, 10);
    const anioNum = parseInt(anio, 10);
    if (mesNum < 1 || mesNum > 12) {
      return res.status(422).json({ message: 'El mes debe estar entre 1 y 12.' });
    }
    if (anioNum < 2000 || anioNum > 2100) {
      return res.status(422).json({ message: 'El año no es válido.' });
    }
    periodoSQL = `${anioNum}-${String(mesNum).padStart(2, '0')}-01`;
    vencimientoSQL = `${anioNum}-${String(mesNum).padStart(2, '0')}-${new Date(Date.UTC(anioNum, mesNum, 0)).getUTCDate()}`;
  } else if (periodo) {
    periodoSQL = periodo;
    vencimientoSQL = fecha_vencimiento || periodo;
  } else {
    return res.status(422).json({ message: 'Debe enviar mes y año (o un periodo). Ejemplo: { "mes": 10, "anio": 2026 }' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [viviendas] = await connection.query(
      'SELECT id_vivienda FROM vivienda WHERE id_comunidad = ? AND activa = TRUE',
      [req.usuario.id_comunidad]
    );
    const [conceptos] = await connection.query(
      'SELECT id_concepto, monto FROM concepto_cuota WHERE id_comunidad = ? AND activo = TRUE',
      [req.usuario.id_comunidad]
    );

    if (viviendas.length === 0 || conceptos.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(422).json({
        message: 'No hay viviendas activas o conceptos activos para generar cuotas. Créelos primero.'
      });
    }

    let cuotasCreadas = 0;
    let duplicadas = 0;

    for (const vivienda of viviendas) {
      for (const concepto of conceptos) {
        try {
          await connection.query(
            `INSERT INTO cuota (id_vivienda, id_concepto, periodo, monto, fecha_vencimiento)
             VALUES (?, ?, ?, ?, ?)`,
            [vivienda.id_vivienda, concepto.id_concepto, periodoSQL, concepto.monto, vencimientoSQL]
          );
          cuotasCreadas++;
        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            duplicadas++;
          } else {
            throw err;
          }
        }
      }
    }

    await connection.query(
      `INSERT INTO bitacora (id_usuario, accion, detalle)
       VALUES (?, 'generar_cuotas', ?)`,
      [req.usuario.id_usuario, `Periodo ${periodoSQL}: ${cuotasCreadas} cuotas creadas, ${duplicadas} duplicadas omitidas`]
    );

    await connection.commit();
    connection.release();

    res.status(201).json({
      mensaje: `Generación terminada: ${cuotasCreadas} cuotas nuevas, ${duplicadas} ya existían.`,
      periodo: periodoSQL,
      cuotas_creadas: cuotasCreadas,
      duplicadas_omitidas: duplicadas
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    connection.release();
    res.status(500).json({ message: 'Error al generar cuotas', error: error.message });
  }
});

// ==========================================
// LISTAR CUOTAS CON FILTROS (RF-12)
// ==========================================
router.get('/cuotas', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    let limite = parseInt(req.query.limite, 10) || 20;
    if (limite < 1) limite = 20;
    if (limite > 100) limite = 100;

    let sqlBase = `
      SELECT c.id_cuota, cc.nombre AS descripcion, c.periodo, c.monto, c.fecha_vencimiento,
             v.identificador AS vivienda, COALESCE(p.pagado, 0) AS pagado,
             (c.monto - COALESCE(p.pagado, 0)) AS saldo,
             ${SQL_ESTADO} AS estado
      FROM cuota c
      JOIN vivienda v ON v.id_vivienda = c.id_vivienda
      JOIN concepto_cuota cc ON cc.id_concepto = c.id_concepto
      LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p ON p.id_cuota = c.id_cuota
      WHERE v.id_comunidad = ?`;
    const params = [req.usuario.id_comunidad];

    if (req.query.mes) { sqlBase += ' AND MONTH(c.periodo) = ?'; params.push(parseInt(req.query.mes, 10)); }
    if (req.query.anio) { sqlBase += ' AND YEAR(c.periodo) = ?'; params.push(parseInt(req.query.anio, 10)); }
    if (req.query.id_vivienda) { sqlBase += ' AND c.id_vivienda = ?'; params.push(parseInt(req.query.id_vivienda, 10)); }
    if (req.query.id_concepto) { sqlBase += ' AND c.id_concepto = ?'; params.push(parseInt(req.query.id_concepto, 10)); }

    let sql = `SELECT * FROM (${sqlBase}) AS resultado`;
    if (req.query.estado) {
      sql += ' WHERE estado = ?';
      params.push(req.query.estado);
    }
    sql += ' ORDER BY periodo DESC, vivienda LIMIT ? OFFSET ?';
    params.push(limite, (pagina - 1) * limite);

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar cuotas', error: error.message });
  }
});

// ==========================================
// ESTADO DE CUENTA DEL RESIDENTE (RF-11 + RF-16)
// ==========================================
router.get('/residente/cuotas', verificarToken, async (req, res) => {
  try {
    const [viviendaRows] = await pool.query(
      'SELECT id_vivienda FROM vivienda WHERE id_responsable = ? AND activa = TRUE',
      [req.usuario.id_usuario]
    );
    if (viviendaRows.length === 0) return res.json([]);

    const idVivienda = viviendaRows[0].id_vivienda;

    const [rows] = await pool.query(
      `SELECT c.id_cuota, cc.nombre AS descripcion, c.periodo, c.monto,
              COALESCE(p.pagado, 0) AS pagado,
              ${SQL_ESTADO} AS estado,
              (SELECT numero_recibo FROM pago
                WHERE id_cuota = c.id_cuota AND anulado = FALSE
                ORDER BY fecha_pago DESC LIMIT 1) AS numero_recibo
       FROM cuota c
       JOIN concepto_cuota cc ON cc.id_concepto = c.id_concepto
       LEFT JOIN (${SQL_PAGOS_POR_CUOTA}) p ON p.id_cuota = c.id_cuota
       WHERE c.id_vivienda = ?
       ORDER BY c.periodo DESC`,
      [idVivienda]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al consultar sus cuotas', error: error.message });
  }
});

module.exports = router;
