#[cfg(any(feature = "kronos", feature = "ttm", feature = "chronos", feature = "moirai"))]
pub(crate) mod assets;

#[cfg(feature = "kronos")]
pub(crate) mod kronos;
#[cfg(feature = "kronos")]
mod kronos_math;

#[cfg(any(feature = "ttm", feature = "chronos", feature = "moirai"))]
pub(crate) mod framework;

#[cfg(feature = "ttm")]
pub(crate) mod ttm;
#[cfg(feature = "ttm")]
mod ttm_math;

#[cfg(feature = "chronos")]
pub(crate) mod chronos;
#[cfg(feature = "chronos")]
mod chronos_math;

#[cfg(feature = "moirai")]
pub(crate) mod moirai;
#[cfg(feature = "moirai")]
mod moirai_math;
