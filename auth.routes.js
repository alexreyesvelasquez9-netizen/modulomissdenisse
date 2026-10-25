// ---------- Generar token JWT de 8 horas ----------
    const token = jwt.sign(
      { id_usuario: usuario.id_usuario, id_comunidad: usuario.id_comunidad, rol: usuario.rol },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    await registrarBitacora(usuario.id_usuario, 'login', `Inicio de sesión de ${usuario.correo}`);

    res.json({
      token,
      usuario: {
        id_usuario: usuario.id_usuario,
        id_comunidad: usuario.id_comunidad, // <-- ESTE CAMPO ES VITAL PARA EL DASHBOARD
        nombre_completo: usuario.nombre_completo,
        correo: usuario.correo,
        rol: usuario.rol,
        debe_cambiar_clave: !!usuario.debe_cambiar_clave
      }
    });
