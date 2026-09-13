"""Demo package for IBVAP.
Provides deterministic 15-step demonstration feeding synthetic detection inputs
through the real production pipeline.
"""
from demo.demo_engine import DemoEngine, get_demo_engine

__all__ = ["DemoEngine", "get_demo_engine"]
