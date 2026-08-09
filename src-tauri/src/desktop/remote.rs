use reqwest::{
    header::{HeaderValue, COOKIE, ORIGIN, SET_COOKIE},
    Method, StatusCode,
};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::{
    config::DesktopState,
    models::{CommandError, LoginApiResponse, RemoteLogin},
};

pub enum RemoteLoginError {
    Rejected(CommandError),
    Unavailable,
}

fn endpoint(state: &DesktopState, path: &str) -> Result<url::Url, CommandError> {
    state.api_base_url.join(path).map_err(|_| {
        CommandError::new(
            "DESKTOP_CONFIG_INVALID",
            "Endpoint server Desktop tidak valid.",
        )
    })
}

fn session_cookie(headers: &reqwest::header::HeaderMap) -> Option<Zeroizing<String>> {
    headers.get_all(SET_COOKIE).iter().find_map(|header| {
        header.to_str().ok()?.split(';').find_map(|part| {
            part.trim()
                .strip_prefix("sppg_session=")
                .filter(|value| !value.is_empty())
                .map(|value| Zeroizing::new(value.to_owned()))
        })
    })
}

pub async fn login(
    state: &DesktopState,
    identifier: &str,
    password: &str,
) -> Result<RemoteLogin, RemoteLoginError> {
    let url = endpoint(state, "/api/auth/login").map_err(RemoteLoginError::Rejected)?;
    let response = state
        .http
        .post(url)
        .header(ORIGIN, state.server_origin.as_str())
        .json(&json!({ "username": identifier, "password": password }))
        .send()
        .await
        .map_err(|_| RemoteLoginError::Unavailable)?;
    let status = response.status();
    let token = session_cookie(response.headers());
    let body = response
        .json::<LoginApiResponse>()
        .await
        .map_err(|_| RemoteLoginError::Unavailable)?;

    if status.is_success() && body.sukses {
        let operator = body.operator.ok_or(RemoteLoginError::Unavailable)?;
        let token = token.ok_or(RemoteLoginError::Unavailable)?;
        return Ok(RemoteLogin {
            operator,
            token,
            message: body
                .pesan
                .unwrap_or_else(|| "Login online berhasil.".into()),
        });
    }

    if status.is_server_error() {
        return Err(RemoteLoginError::Unavailable);
    }
    let code = if status == StatusCode::TOO_MANY_REQUESTS {
        "LOGIN_RATE_LIMITED"
    } else {
        "LOGIN_REJECTED"
    };
    Err(RemoteLoginError::Rejected(CommandError::new(
        code,
        body.pesan
            .unwrap_or_else(|| "Username atau password tidak sesuai.".into()),
    )))
}

pub async fn authorized_json(
    state: &DesktopState,
    method: Method,
    path: &str,
    body: Option<Value>,
    token: &str,
) -> Result<Value, CommandError> {
    let url = endpoint(state, path)?;
    let cookie = HeaderValue::from_str(&format!("sppg_session={token}"))
        .map_err(|_| CommandError::internal())?;
    let mut request = state
        .http
        .request(method, url)
        .header(ORIGIN, state.server_origin.as_str())
        .header(COOKIE, cookie);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| {
        CommandError::new(
            "DESKTOP_SERVER_UNAVAILABLE",
            "Server pelanggan tidak dapat dijangkau. Tindakan keamanan wajib online.",
        )
    })?;
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    if status.is_success() {
        return Ok(payload);
    }
    let message = payload
        .get("pesan")
        .and_then(Value::as_str)
        .unwrap_or("Permintaan server tidak dapat diproses.");
    let code = match status {
        StatusCode::UNAUTHORIZED => "DESKTOP_SESSION_EXPIRED",
        StatusCode::FORBIDDEN => "DESKTOP_ACCESS_DENIED",
        _ => "DESKTOP_API_ERROR",
    };
    Err(CommandError::new(code, message))
}

pub async fn logout(state: &DesktopState, token: &str) {
    let _ = authorized_json(state, Method::DELETE, "/api/auth/session", None, token).await;
}

#[cfg(test)]
mod tests {
    use reqwest::header::{HeaderMap, HeaderValue, SET_COOKIE};

    use super::session_cookie;

    #[test]
    fn extracts_only_the_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("theme=dark; Path=/; SameSite=Lax"),
        );
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static(
                "sppg_session=header.payload.signature; Path=/; HttpOnly; Secure",
            ),
        );

        assert_eq!(
            session_cookie(&headers).as_deref().map(String::as_str),
            Some("header.payload.signature")
        );
    }

    #[test]
    fn rejects_an_empty_session_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            SET_COOKIE,
            HeaderValue::from_static("sppg_session=; Path=/; HttpOnly"),
        );
        assert!(session_cookie(&headers).is_none());
    }
}
