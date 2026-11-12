"""Watcher control API (contracts/api.md, "Watcher control"). Internal only."""

from __future__ import annotations

import hmac
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import db
from .control import Controller

log = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


class ReplayStart(BaseModel):
    election_id: str = Field(pattern=r"^[a-z0-9-]+$")
    timeline: str = Field(min_length=1)
    speed: float = Field(default=30, ge=1, le=60)


def create_app(controller: Controller | None = None, admin_token: str | None = None,
               live_election: str | None = None) -> FastAPI:
    token = admin_token if admin_token is not None else os.environ.get("WATCHER_ADMIN_TOKEN", "")
    ctl = controller or Controller(os.environ.get("DATABASE_URL", ""))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if live_election:
            await ctl.start_live(live_election)
        yield
        await ctl.stop()

    app = FastAPI(title="Proof of Signal watcher", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.controller = ctl

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, e: ApiError):
        return _err(e.status, e.code, e.message)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, e: RequestValidationError):
        return _err(400, "invalid_body", "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, e: StarletteHTTPException):
        return _err(e.status_code, "not_found" if e.status_code == 404 else "invalid_body", str(e.detail))

    @app.exception_handler(Exception)
    async def _internal(_: Request, e: Exception):
        log.exception("unhandled")
        return _err(500, "internal", "internal error")

    def require_admin(request: Request) -> None:
        auth = request.headers.get("authorization", "")
        given = auth[7:] if auth[:7].lower() == "bearer " else ""
        if not token or not given or not hmac.compare_digest(given.encode(), token.encode()):
            raise ApiError(401, "unauthenticated", "admin token required")

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    @app.get("/status", dependencies=[Depends(require_admin)])
    async def status():
        return ctl.status()

    @app.post("/replay/start", dependencies=[Depends(require_admin)])
    async def replay_start(body: ReplayStart):
        try:
            info = await ctl.start_replay(body.election_id, body.timeline, body.speed)
        except FileNotFoundError as e:
            raise ApiError(404, "not_found", str(e))
        except db.NotFound as e:
            raise ApiError(404, "not_found", str(e))
        except db.Forbidden as e:
            raise ApiError(403, "forbidden", str(e))
        except ValueError as e:
            raise ApiError(400, "invalid_body", str(e))
        return {"started": True, **info, "status": ctl.status()}

    @app.post("/replay/stop", dependencies=[Depends(require_admin)])
    async def replay_stop():
        if ctl.mode == "live":
            raise ApiError(403, "forbidden", "the watcher is in live mode; /replay/stop only stops replays")
        stopped = await ctl.stop()
        return {"stopped": stopped, "status": ctl.status()}

    return app
